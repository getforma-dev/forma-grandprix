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
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GP_')));
  return { root, put, env: { ...cleanEnv, GP_RUN_ID: 'server-test-1', GP_FORMA_REF: exact, GP_CARS: 'forma', GP_EVENTS: '1', GITHUB_REPOSITORY: 'getforma-dev/forma-grandprix', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GP_REQUEST_ID: 'local-receipt' } };
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

test('attempt source metadata follows its suite even when other lane variables are inherited', t => {
  const f = fixture(t), env = { ...f.env, GP_FORMA_REFS: 'b'.repeat(40) };
  assert.deepEqual(beginAttempt(f.root, 'server', env).formaSourceCommits, [exact]);
  assert.deepEqual(beginAttempt(f.root, 'client', { ...env, GP_RUN_ID: 'client-test-1' }).formaSourceCommits, ['b'.repeat(40)]);
  assert.deepEqual(beginAttempt(f.root, 'islands', { ...env, GP_RUN_ID: 'islands-test-1' }).formaSourceCommits, []);
});

// Deterministic synthetic evidence exercises the real transport, campaign,
// resource-profile and budget validators; it performs no timed benchmark.
import { profileConfiguration } from '../harness/resource-profile.mjs';
import { requestHeaders, captureResponse, ohaArguments, wireMeasurement } from '../harness/transport.mjs';
import { renderPage } from '../contestants/vanilla-node/src/page.vanilla.mjs';
import { collectReport } from '../src/report.mjs';
import { authenticatePhaseReceipt } from '../harness/ci-run.mjs';
const wrapperUrl = new URL('../harness/ci-run.mjs', import.meta.url).href;
const budgetsUrl = new URL('../harness/budgets.mjs', import.meta.url).href;
function qualifiedBudgetRecords() {
  const profile = profileConfiguration({ name: 'gha-4-v1', githubActions: true, availableCpus: 4, affinity: [0,1,2,3] });
  const campaign = { schema: 1, id: 'b6ee6a58-a306-4b43-b3f3-d42d6ae279a1', createdAt: '2026-10-24T17:00:00.000Z', kind: 'github-actions',
    hostSha256: 'a'.repeat(64), machineIdSha256: 'b'.repeat(64), runnerTrackingSha256: 'c'.repeat(64), github: { runId: '123', runAttempt: '1', job: 'campaign', repository: 'getforma-dev/forma-grandprix' } };
  const headers = requestHeaders(), responses = Object.fromEntries([10,100,1000].map(rows => [rows,captureResponse(rows,{status:200,headers:{},rawHeaders:[],body:Buffer.from(renderPage(rows))},headers)]));
  const load = z => {
    const requested={c:64,z},target='http://car:3000/ssr?rows=100',bytes=responses[100].bytes;
    const run={requested,target,response:responses[100],requestHeaders:headers,arguments:ohaArguments(target,requested,headers),nonOk:0,successRate:1,errorDistribution:{},statusCodes:{200:100},requests:100,ok:100,seconds:z,okRps:100/z,bytesPerRequest:bytes,totalData:bytes*100,rawOha:{summary:{total:z,successRate:1,totalData:bytes*100,sizePerRequest:bytes},statusCodeDistribution:{200:100},errorDistribution:{}}};run.wireBytes=wireMeasurement(run,responses[100]);return run;
  };
  const base=event=>({event,car:'forma',image:{id:'sha256:'+'a'.repeat(64)},campaign,config:{resourceProfile:profile,requestHeaders:headers,forced:false,duration:10,warmup:5,runs:3,starts:5,buildRuns:3,concurrency:64,classA:profile.classA,classB:profile.classB,loadgenCpus:profile.loadgen.cpus,loadgenCpuset:profile.loadgen.cpuset,buildCpus:profile.build.cpus,buildCpuset:profile.build.cpuset}});
  return {
    smoke:{pass:true,campaign,requestHeaders:headers,responses,image:{id:'sha256:'+'a'.repeat(64)}},
    sprint:{...base('sprint'),response:responses[100],warmup:load(5),durationS:10,warmupS:5,concurrency:64,container:profile.classA,runs:Array.from({length:3},()=>load(10)),values:[10,10,10]},
    fuel:{...base('fuel'),metric:{unit:'MiB'},values:[8.01,8.01,8.01],runs:Array.from({length:3},()=>({samples:10}))},
    grid:{...base('grid'),metric:{unit:'ms'},values:[200,200,200,200,200],runs:Array.from({length:5},()=>({ms:200,dockerRunReturnedMs:175}))},
    weight:{...base('weight'),parts:{image:{metric:{unit:'bytes'},values:[140000000]},gzip:{metric:{unit:'bytes'},values:[1000],rawBytes:responses[100].bytes}}},
  };
}
async function budgetFixture(t,{edit=()=>{},worker='normal',extraCar=false}={}) {
  const f=fixture(t);f.env={...f.env,GP_EVENTS:'1,5-7',...(extraCar?{GP_CARS:'forma,react-node'}:{})};
  f.put('harness/ci-run.mjs',`import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
    import {runServerCI} from ${JSON.stringify(wrapperUrl)}; import {evaluateBudgets} from ${JSON.stringify(budgetsUrl)};
    const root=process.env.GP_RESULTS_DIR;
    const compute=()=>{try{const records=Object.fromEntries(['sprint','fuel','grid','weight'].map(event=>[event,JSON.parse(fs.readFileSync(path.join(root,'raw',event,'forma.json')))]));const result=evaluateBudgets(records);fs.writeFileSync(path.join(root,'raw/forma-budgets.json'),JSON.stringify(result));return{status:result.passed?0:1};}catch{return{status:1};}};
    ${worker==='driver-failure'?"compute();process.exitCode=1;":`process.exitCode=runServerCI({prepare:()=>{},spawn:(program,args,options)=>{assert.equal(options.env.GP_CI_PHASE_TOKEN,undefined,'receipt key leaked to child');return args[0].endsWith('budgets.mjs')?compute():{status:0};}});`}
    ${worker==='source-change'?"fs.appendFileSync('harness/ci-run.mjs',';// source changed');":''}`);
  beginAttempt(f.root,'server',f.env);const records=qualifiedBudgetRecords();edit(records);
  for(const [event,record] of Object.entries(records))f.put(`runs/${f.env.GP_RUN_ID}/artifacts/raw/${event}/forma.json`,record);
  const code=await captureAttempt(f.root,'server',f.env);assert.equal(code,1);
  return {...f,finishEnv:{...f.env,GP_WORKFLOW_STATUS:'failure',GP_MEASUREMENT_OUTCOME:'failure',GP_DOCKER_CLEANUP_OUTCOME:'success'}};
}
test('a deliberate target miss fails CI acceptance but preserves complete qualified measurements',async t=>{
 const f=await budgetFixture(t);const result=await finishAttempt(f.root,'server',f.finishEnv);const manifest=JSON.parse(fs.readFileSync(path.join(result.directory,'manifest.json')));
 assert.equal(result.status,'failed');assert.equal(result.quality,'qualified');assert.equal(manifest.exitCode,1);assert.equal(manifest.workflowStatus,'failure');assert.equal(manifest.performanceAcceptance.status,'missed');assert.equal(manifest.performanceAcceptance.onlyFailure,true);assert.equal(manifest.performanceAcceptance.limits.peakMiB,8);assert.equal(manifest.performanceAcceptance.measured.peakMiB,8.01);assert.equal(manifest.performanceAcceptance.checks.find(check=>!check.passed).metric,'peakMiB');assert(collectReport(result.directory).measurements.every(row=>row.qualification==='qualified'&&row.status==='measured'));assert.equal(verify(result.directory).ok,true);assert(!fs.readFileSync(path.join(result.directory,'manifest.json'),'utf8').includes('GP_CI_PHASE_TOKEN'));
});
test('invalid transport, partial grid and source mutation cannot acquire qualification through a budget miss',async t=>{
 for(const options of [{edit:r=>{r.sprint.runs[0].successRate=0.9;}},{extraCar:true},{worker:'source-change'},{worker:'driver-failure'}]){
  const f=await budgetFixture(t,options),result=await finishAttempt(f.root,'server',f.finishEnv);assert.equal(result.quality,'unqualified');assert(['failed','invalid'].includes(result.status));assert.equal(JSON.parse(fs.readFileSync(path.join(result.directory,'manifest.json'))).performanceAcceptance.onlyFailure,false);assert.equal(verify(result.directory).ok,true);
 }
});
test('cleanup failure or unknown workflow outcomes cannot be relabelled a budget-only failure',async t=>{
 for(const outcome of ['failure',undefined]){
  const f=await budgetFixture(t);const result=await finishAttempt(f.root,'server',{...f.finishEnv,GP_DOCKER_CLEANUP_OUTCOME:outcome});const manifest=JSON.parse(fs.readFileSync(path.join(result.directory,'manifest.json')));assert.equal(result.quality,'unqualified');assert.equal(manifest.performanceAcceptance.onlyFailure,false);
 }
 const f=await budgetFixture(t);f.put('.grandprix/active.json',{pid:process.pid,runId:'someone-else',hostname:os.hostname(),operation:'run',phase:'preflight'});const result=await finishAttempt(f.root,'server',f.finishEnv);assert.equal(result.quality,'unqualified');assert.equal(JSON.parse(fs.readFileSync(path.join(result.directory,'manifest.json'))).cleanup.completed,false);
});
test('changed phase receipts or budget files cannot masquerade as an authenticated acceptance failure',async t=>{
 for(const file of ['ci-phases.json','raw/forma-budgets.json']){
  const f=await budgetFixture(t);fs.appendFileSync(path.join(f.root,'runs',f.env.GP_RUN_ID,'artifacts',file),' ');const result=await finishAttempt(f.root,'server',f.finishEnv);const manifest=JSON.parse(fs.readFileSync(path.join(result.directory,'manifest.json')));assert.equal(result.quality,'unqualified');assert.equal(manifest.performanceAcceptance.status,'unverified');
 }
});

test('phase authentication rejects an unrelated key or run identity',async t=>{
 const f=await budgetFixture(t),file=path.join(f.root,'runs',f.env.GP_RUN_ID,'artifacts/ci-phases.json');assert.throws(()=>authenticatePhaseReceipt(file,'0'.repeat(64),f.env.GP_RUN_ID),/authentication failed/);assert.throws(()=>authenticatePhaseReceipt(file,'0'.repeat(64),'another-run'));
});
