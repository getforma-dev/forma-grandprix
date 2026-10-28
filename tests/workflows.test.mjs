import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = name => fs.readFileSync(new URL('../.github/workflows/' + name, import.meta.url), 'utf8');
for (const suite of ['server', 'client', 'islands', 'paired', 'compression']) test(`${suite}: standalone manual workflow retains failure evidence and dispatch correlation`, () => {
  const workflow = read(suite === 'server' ? 'grand-prix.yml' : `grand-prix-${suite}.yml`);
  assert.match(workflow, /workflow_dispatch:/); assert.doesNotMatch(workflow, /\n  (pull_request|push|schedule):/);
  assert.doesNotMatch(workflow, /benchmarks\/grand-prix|inputs\.forma_refs \|\| github\.sha/);
  assert.match(workflow, /default: ubuntu-24\.04/); assert.match(workflow, /default: gha-4-v1/);
  assert.match(workflow, /diagnostic:[\s\S]*?default: false/); assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /run-name:.*inputs\.request_id/);
  assert.match(workflow, /npm test/);
  const begin = workflow.indexOf(`node src/ci-capture.mjs begin ${suite}`), prepare = workflow.indexOf(`node src/ci-capture.mjs prepare ${suite}`);
  const run = workflow.indexOf(`node src/ci-capture.mjs run ${suite}`), finish = workflow.indexOf(`node src/ci-capture.mjs finish ${suite}`);
  assert(begin > 0 && prepare > begin && run > prepare && finish > run);
  assert.match(workflow, /name: Compact generated outputs[\s\S]*?if: always\(\)/);
  assert.match(workflow, /name: Retain every attempt[\s\S]*?if: always\(\)/);
  assert.match(workflow, /path: runs\/\$\{\{ env\.GP_RUN_ID \}\}\//);
  assert.match(workflow, new RegExp(`name: grand-prix-${suite}-`));
  assert.match(workflow, /retention-days: 30/); assert.match(workflow, /GITHUB_STEP_SUMMARY/);
  for (const action of workflow.matchAll(/uses: ([^\s]+)/g)) assert.match(action[1], /@[a-f0-9]{40}$/);
  assert.doesNotMatch(workflow, /(?:docker|buildx) (?:system )?prune/);
});
test('push and PR checks are independent of expensive campaigns', () => {
  const workflow = read('ci.yml');
  assert.match(workflow, /\n  push:/); assert.match(workflow, /\n  pull_request:/);
  assert.match(workflow, /run: npm test/); assert.match(workflow, /verify\.py/);
  assert.doesNotMatch(workflow, /ci-capture\.mjs|linux-run\.mjs|docker build/);
});
