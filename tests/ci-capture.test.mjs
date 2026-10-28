import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beginAttempt, captureAttempt, finishAttempt, driverPlan, eventSelection } from '../src/ci-capture.mjs';
import { verify } from '../src/session.mjs';

const exact = 'a'.repeat(40);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-ci-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (relative, value) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  put('config/laboratory.json', { protocolVersion: 'test', suites: { server: { cars: ['forma', 'react-node'] }, islands: { cars: ['forma', 'react-node'] }, client: { cars: ['forma', 'react'] } } });
  put('harness/chromium-linux-lock.json', { executableSha256: 'b'.repeat(64) });
  return { root, put, env: { ...process.env, GP_RUN_ID: 'server-test-1', GP_FORMA_REF: exact, GP_CARS: 'forma', GP_EVENTS: '1', GITHUB_REPOSITORY: 'getforma-dev/forma-grandprix', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GP_REQUEST_ID: 'local-receipt' } };
}
test('hosted defaults qualify only on explicit runtime evidence and preserve exact source selection', t => {
  const f = fixture(t), plan = driverPlan(f.root, 'server', f.env);
  assert.equal(plan.profile, 'gha-4-v1'); assert.equal(plan.diagnostic, false);
  assert.deepEqual(plan.formaRefs, [exact]); assert.equal(plan.env.GP_FORMA_REF, exact);
  for (const value of ['main', 'HEAD', exact + ',main', exact + ',' + exact]) assert.throws(() => driverPlan(f.root, 'server', { ...f.env, GP_FORMA_REF: value }), /exact|unique/);
  assert.throws(() => driverPlan(f.root, 'server', { ...f.env, GP_PROFILE: 'custom' }), /profile/);
  assert.throws(() => driverPlan(f.root, 'server', { ...f.env, GP_DIAGNOSTIC: 'yes' }), /true or false/);
  assert.throws(() => driverPlan(f.root, 'server', { ...f.env, GP_CARS: 'unknown' }), /competitor/);
});
test('selected events never silently expand for strength budgets', t => {
  const f = fixture(t);
  assert.deepEqual(eventSelection('1,5-7'), ['sprint', 'fuel', 'grid', 'weight']);
  for (const value of ['0', '9', '7-1', '1;echo', 'sprint']) assert.throws(() => eventSelection(value));
  const subset = driverPlan(f.root, 'server', f.env);
  assert.equal(subset.env.GP_EVENTS, '1'); assert.equal(subset.env.GP_CHECK_BUDGETS, 'false');
  const full = driverPlan(f.root, 'server', { ...f.env, GP_EVENTS: '1-8' });
  assert.equal(full.env.GP_CHECK_BUDGETS, 'true');
  assert.equal(driverPlan(f.root, 'server', { ...f.env, GP_CARS: 'react-node', GP_EVENTS: '1-8' }).budgetCheck.applicable, false);
});
test('browser and paired controls retain exact selections and diagnostic flags', t => {
  const f = fixture(t), env = { ...f.env, GP_FORMA_REFS: exact, CHROME_PATH: '/authenticated/chrome', GP_DIAGNOSTIC: 'true', GP_PROFILE_ROWS: 'true' };
  const client = driverPlan(f.root, 'client', env);
  assert(client.args.includes('--profile-rows')); assert(client.args.includes('--diagnostic')); assert(client.args.includes(exact));
  assert(driverPlan(f.root, 'paired', env).args.includes('harness/paired-server.mjs'));
  assert.equal(driverPlan(f.root, 'compression', env).env.GP_COMPRESSION, 'true');
  assert.throws(() => driverPlan(f.root, 'paired', { ...env, GP_FORMA_REFS: '' }), /requires/);
  assert.throws(() => driverPlan(f.root, 'client', { ...env, CHROME_PATH: 'relative' }), /browser/);
  const islands = driverPlan(f.root, 'islands', { ...env, GP_CARS: 'all', GP_FORMA_REFS: '', GP_FORMA_REF: '' });
  assert.equal(islands.args.at(-2), 'forma,react-node');
  assert.throws(() => driverPlan(f.root, 'islands', env), /unsupported/);
});
test('preparation failure is retained, readable, sealed, and cannot replace prior evidence', async t => {
  const f = fixture(t), manifest = beginAttempt(f.root, 'server', f.env);
  assert.equal(manifest.remote.requestId, 'local-receipt'); assert.equal(manifest.remote.runId, '123');
  assert.equal(manifest.quality, 'unqualified'); assert.deepEqual(manifest.formaSourceCommits, [exact]);
  assert.deepEqual(manifest.expected, [{ event: 'sprint', car: 'forma' }]);
  assert.throws(() => beginAttempt(f.root, 'server', f.env), /already exists/);
  const result = await finishAttempt(f.root, 'server', { ...f.env, GP_WORKFLOW_STATUS: 'failure' });
  assert.equal(result.status, 'failed'); assert.equal(result.quality, 'unqualified');
  for (const name of ['manifest.json', 'integrity.json', 'report.md', 'report.html', 'report.json', 'measurements.csv']) assert(fs.existsSync(path.join(result.directory, name)), name);
  assert.equal(verify(result.directory).ok, true);
  const report = JSON.parse(fs.readFileSync(path.join(result.directory, 'report.json')));
  assert(report.measurements.some(row => row.status === 'missing' && row.car === 'forma'));
  await assert.rejects(finishAttempt(f.root, 'server', f.env), /sealed/);
});
test('failed worker logs and samples survive compaction; dependencies and outputs do not', async t => {
  const f = fixture(t);
  f.put('harness/ci-run.mjs', `import fs from 'node:fs'; import path from 'node:path';
    const base = process.env.GP_RESULTS_DIR;
    for (const [name, content] of [['raw/sprint/forma.failed.json',JSON.stringify({event:'sprint',car:'forma',error:'deliberate control'})],['case-contexts/forma/target/generated.bin','generated'],['case-contexts/forma/Cargo.lock','locked'],['case-client/published/client-race/node_modules/lib/index.js','dependency']]) {const file=path.join(base,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);}
    console.log('deliberate worker failure'); process.exitCode = 7;`);
  beginAttempt(f.root, 'server', f.env);
  assert.equal(await captureAttempt(f.root, 'server', f.env), 7);
  assert(!fs.existsSync(path.join(f.root, '.grandprix/active.json')));
  const result = await finishAttempt(f.root, 'server', { ...f.env, GP_WORKFLOW_STATUS: 'failure' });
  assert.equal(result.status, 'failed'); assert.equal(result.quality, 'unqualified');
  assert.match(fs.readFileSync(path.join(result.directory, 'run.log'), 'utf8'), /deliberate worker failure/);
  const artifact = relative => path.join(result.directory, 'artifacts', relative);
  assert(fs.existsSync(artifact('raw/sprint/forma.failed.json')));
  assert(fs.existsSync(artifact('case-contexts/forma/Cargo.lock')));
  assert(!fs.existsSync(artifact('case-contexts/forma/target')));
  assert(!fs.existsSync(artifact('case-client/published/client-race/node_modules')));
  assert.equal(verify(result.directory).ok, true);
  fs.writeFileSync(artifact('raw/sprint/forma.failed.json'), '{}');
  assert.equal(verify(result.directory).ok, false);
});
test('zero exit without evidence cannot qualify and source mutation invalidates a worker', async t => {
  for (const mutate of [false, true]) {
    const f = fixture(t);
    f.put('harness/ci-run.mjs', mutate ? `import fs from 'node:fs';fs.appendFileSync('harness/ci-run.mjs',';// changed during execution');` : '// no observations');
    beginAttempt(f.root, 'server', f.env);
    assert.equal(await captureAttempt(f.root, 'server', f.env), mutate ? 1 : 0);
    const result = await finishAttempt(f.root, 'server', f.env);
    assert.equal(result.quality, 'unqualified'); assert.equal(result.status, mutate ? 'invalid' : 'completed');
    assert.equal(verify(result.directory).ok, true);
  }
});
