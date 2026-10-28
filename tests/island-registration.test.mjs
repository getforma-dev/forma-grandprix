import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CARS } from '../harness/islands-linux.mjs';
import { entrantsFor } from '../harness/registry.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
function fixture(t, cars) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-island-registration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (name, value) => { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
  for (const name of ['island-race/run.mjs', 'harness/campaign.mjs', 'harness/island-source.mjs', 'harness/resource-profile.mjs', 'harness/registry.mjs', 'shared/dataset.mjs']) put(name, fs.readFileSync(path.join(root, name)));
  put('config/laboratory.json', JSON.stringify({ suites: { islands: { cars } } }));
  put('island-race/node_modules/puppeteer-core/package.json', JSON.stringify({ type: 'module', exports: './index.js' }));
  put('island-race/node_modules/puppeteer-core/index.js', "export default {launch(){throw Error('browser must not be reached by registration controls')}};");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GP_')));
  return car => spawnSync(process.execPath, [path.join(dir, 'island-race/run.mjs'), '--car', car,
    '--url', 'http://127.0.0.1:1', '--chrome', '/unavailable-control-browser', '--out', path.join(dir, 'never-measured.json')], { env, encoding: 'utf8', timeout: 10000 });
}
test('driver uses the central island identity registry', () => {
  assert.deepEqual(CARS, entrantsFor('islands'));
});
test('runner accepts a newly registered identity and still refuses unregistered historical identities', t => {
  const run = fixture(t, ['new-framework']);
  const registered = run('new-framework');
  assert.notEqual(registered.status, 0);
  assert.match(registered.stderr, /qualified run requires a campaign identity/, 'registered selection reaches the next qualification gate without a browser');
  for (const car of ['forma', 'unregistered', '../new-framework']) {
    const rejected = run(car);
    assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /--car, --url, --chrome and --out are required/);
    assert.doesNotMatch(rejected.stderr, /browser must not be reached/);
  }
});
test('malformed or duplicate central registrations fail before measurement', t => {
  for (const cars of [[], ['forma', 'forma'], ['../forma'], ['new framework']]) {
    const rejected = fixture(t, cars)('forma');
    assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /Invalid entrant registry: islands/);
  }
});
