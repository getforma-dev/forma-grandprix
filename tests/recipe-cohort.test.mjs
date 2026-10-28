import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceFixture } from '../harness/source-fixtures.mjs';
import { prepareCars } from '../harness/prepare-car.mjs';
import { archiveForma } from '../harness/forma-source.mjs';

test('laboratory recipes retain reviewed lock bytes from exact Git HEAD while historical recipes stay unchanged', t => {
  const f = sourceFixture(t), relative = 'next/package-lock.json';
  const original = readFileSync(join(f.laboratory, 'contestants', relative), 'utf8');
  cpSync(join(f.laboratory, 'contestants'), join(f.forma, 'benchmarks/grand-prix/contestants'), { recursive: true });
  f.git(f.forma, 'add', '.');
  f.git(f.forma, '-c', 'user.name=Grand Prix Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Synthetic immutable historical recipes');
  const historicalCommit = f.git(f.forma, 'rev-parse', 'HEAD');
  // Fixture-only dependency change: no install, build or timing is performed.
  const lock = JSON.parse(original); lock.packages['node_modules/next'].version = '0.0.0-cohort-fixture';
  const updated = JSON.stringify(lock) + '\n';
  f.write(f.laboratory, 'contestants/' + relative, updated); f.git(f.laboratory, 'add', '.');
  f.git(f.laboratory, '-c', 'user.name=Grand Prix Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Reviewed fixture dependency change');
  const laboratoryCommit = f.git(f.laboratory, 'rev-parse', 'HEAD');
  f.write(f.laboratory, 'contestants/' + relative, 'uncommitted bytes must never enter an archived recipe');
  const prepared = prepareCars(f.laboratory, join(f.directory, 'current-context'), {
    baseline: false, formaRef: f.formaCommit, sourceOptions: { repository: f.forma, fetch: false },
  });
  assert.equal(readFileSync(join(prepared, relative), 'utf8'), updated);
  const candidate = JSON.parse(readFileSync(join(prepared, 'forma/candidate-source.json'), 'utf8'));
  assert.equal(candidate.carSource.commit, laboratoryCommit); assert.equal(candidate.commit, f.formaCommit);
  const historical = join(f.directory, 'historical-context');
  archiveForma(historicalCommit, [], historical, { root: f.laboratory, repository: f.forma, fetch: false, tree: 'benchmarks/grand-prix/contestants' });
  assert.equal(readFileSync(join(historical, relative), 'utf8'), original);
  assert.notEqual(original, updated);
});
