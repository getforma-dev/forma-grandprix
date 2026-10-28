import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ownClientTrial, compactClientTrial } from './client-trial-cleanup.mjs';

function fixture(t, { profileRows = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gp-trial-cleanup-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { runId: 'owned-test', ref: 'a'.repeat(40), labSourceCommit: 'b'.repeat(40), profileRows };
  const parent = path.join(root, `${options.runId}-client`), trial = path.join(parent, options.ref);
  fs.mkdirSync(trial, { recursive: true }); ownClientTrial(trial, options);
  const put = (name, text = 'retained') => { const file = path.join(trial, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
  const driver = { id: options.runId, labSourceCommit: options.labSourceCommit,
    trials: [{ ref: options.ref, labSourceCommit: options.labSourceCommit, formaSourceCommit: options.ref, passed: true }] };
  const save = () => fs.writeFileSync(path.join(parent, 'run.json'), JSON.stringify(driver)); save();
  for (const name of ['client-race/node_modules/lib/index.js', 'client-race/apps/forma/dist/main.js', 'candidate/node_modules/lib/index.js',
    'candidate/packages/core/dist/index.js', 'candidate/crates/server/target/generated', 'signals-race/candidate-core/dist/index.js']) put(name, 'generated');
  const preserved = ['client-race/package-lock.json', 'client-race/apps/forma/main.js', 'candidate/package-lock.json', 'candidate/packages/core/src/index.ts',
    'signals-race/candidate-core/package.json', 'raw/dom/forma.json', 'raw/bundle/forma.json', 'raw/row-profile/forma/dist/trace.json'];
  for (const name of preserved) put(name);
  fs.mkdirSync(path.join(parent, 'published/client-race/node_modules/lib'), { recursive: true });
  fs.writeFileSync(path.join(parent, 'published/client-race/node_modules/lib/index.js'), 'other trial');
  return { root, trial, parent, options, put, driver, save, preserved };
}
test('completed trial compaction retains raw evidence, locks, source and other trials with a bounded receipt', t => {
  const f = fixture(t), result = compactClientTrial(f.trial, f.options);
  assert.equal(result.completed, true); assert.equal(result.removedDirectories, 6); assert(result.plannedBytes > 0);
  for (const name of f.preserved) assert.equal(fs.readFileSync(path.join(f.trial, name), 'utf8'), 'retained');
  assert.equal(fs.readFileSync(path.join(f.parent, 'published/client-race/node_modules/lib/index.js'), 'utf8'), 'other trial');
  const receipt = fs.readFileSync(path.join(f.trial, result.receipt), 'utf8'), record = JSON.parse(receipt);
  assert.equal(record.phase, 'after-measurements'); assert.equal(record.completed, true);
  assert.equal(record.actions.length, 6); assert.equal(record.plannedBytes, record.actions.reduce((sum, item) => sum + item.bytes, 0));
  for (const item of record.actions) { assert(!fs.existsSync(path.join(f.trial, item.path))); assert.match(item.inventorySha256, /^[a-f0-9]{64}$/); }
  assert.throws(() => compactClientTrial(f.trial, f.options), /receipt already exists/);
  assert.equal(fs.readFileSync(path.join(f.trial, result.receipt), 'utf8'), receipt);
});
test('unowned, incomplete and mismatched source trials refuse deletion', t => {
  for (const mutate of [
    f => fs.rmSync(path.join(f.trial, 'trial-ownership.json')),
    f => { f.driver.trials[0].passed = false; f.save(); },
    f => { f.driver.trials[0].formaSourceCommit = 'c'.repeat(40); f.save(); },
    f => { f.driver.labSourceCommit = 'c'.repeat(40); f.save(); },
  ]) {
    const f = fixture(t); mutate(f); assert.throws(() => compactClientTrial(f.trial, f.options));
    assert(fs.existsSync(path.join(f.trial, 'client-race/node_modules/lib/index.js')));
    assert(!fs.existsSync(path.join(f.trial, 'cleanup-after-trial.json')));
  }
});
test('profiling trials retain generated inputs until both row profiles finish', t => {
  const f = fixture(t, { profileRows: true });
  assert.throws(() => compactClientTrial(f.trial, { ...f.options, profileRows: false }), /ownership differs/);
  assert.throws(() => compactClientTrial(f.trial, f.options), /profiling must finish/);
  f.driver.rowProfiles = [{ ref: f.options.ref, car: 'forma', diagnostic: true }]; f.save();
  assert.throws(() => compactClientTrial(f.trial, f.options), /profiling must finish/);
  f.driver.rowProfiles.push({ ref: f.options.ref, car: 'vanilla', diagnostic: true }); f.save();
  compactClientTrial(f.trial, f.options);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.trial, 'cleanup-after-trial.json'))).phase, 'after-row-profiles');
});
test('linked generated paths refuse cleanup; links inside owned dependencies never follow outside', t => {
  const f = fixture(t), outside = path.join(f.root, 'external'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep'), 'external');
  fs.symlinkSync(outside, path.join(f.trial, 'candidate/dist'));
  assert.throws(() => compactClientTrial(f.trial, f.options), /linked generated path/);
  assert(fs.existsSync(path.join(f.trial, 'client-race/node_modules/lib/index.js')));
  fs.rmSync(path.join(f.trial, 'candidate/dist'));
  fs.symlinkSync(outside, path.join(f.trial, 'client-race/node_modules/external'));
  compactClientTrial(f.trial, f.options);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'external');
});
