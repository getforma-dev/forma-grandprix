import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { sourceFixture } from './source-fixtures.mjs';
import { archiveForma, archiveLabContestants, ensureFormaSource, repositoryIdentity, sourceConfiguration } from './forma-source.mjs';

test('explicit source provenance binds full commits and matching repository while keeping lab history separate', t => {
  const f = sourceFixture(t), options = { root: f.laboratory, repository: f.forma, fetch: false };
  const source = ensureFormaSource(f.formaCommit, options);
  assert.equal(source.commit, f.formaCommit); assert.equal(source.repositoryUrl, f.url);
  assert.notEqual(f.labCommit, f.formaCommit);
  for (const ref of ['HEAD', 'main', 'v3.2.0', f.formaCommit.slice(0, 8), '-malicious']) assert.throws(() => ensureFormaSource(ref, options), /exact/);
  assert.throws(() => ensureFormaSource(f.labCommit, options), /missing/);
  f.git(f.forma, 'remote', 'set-url', 'origin', 'https://github.com/example/another.git');
  assert.throws(() => ensureFormaSource(f.formaCommit, options), /origin differs/);
});
test('framework candidate and frozen legacy adapter archives use Forma objects; current contestants use lab objects', t => {
  const f = sourceFixture(t), options = { root: f.laboratory, repository: f.forma, fetch: false };
  const candidate = join(f.directory, 'candidate');
  archiveForma(f.formaCommit, ['Cargo.toml', 'crates', 'packages'], candidate, options);
  assert.match(readFileSync(join(candidate, 'packages/core/source.txt'), 'utf8'), /explicit repository/);
  const historical = join(f.directory, 'historical');
  archiveForma(f.formaCommit, [], historical, { ...options, tree: 'benchmarks/grand-prix/contestants' });
  assert.match(readFileSync(join(historical, 'historical/source.txt'), 'utf8'), /Forma history/);
  const current = join(f.directory, 'current');
  archiveLabContestants(current, f.labCommit, { root: f.laboratory });
  assert(existsSync(join(current, 'forma/Dockerfile')));
  assert.throws(() => archiveForma(f.formaCommit, ['Cargo.toml'], candidate, options), /EEXIST/);
  for (const paths of [['../outside'], ['/tmp/absolute'], ['--output=bad'], ['HEAD:secret']])
    assert.throws(() => archiveForma(f.formaCommit, paths, join(f.directory, 'invalid'), options), /safe/);
});
test('unowned or symlinked caches and unsafe cache settings are refused without fetching', t => {
  const f = sourceFixture(t);
  const cache = join(f.laboratory, '.grandprix/sources/forma.git'); mkdirSync(cache, { recursive: true });
  assert.throws(() => ensureFormaSource(f.formaCommit, { root: f.laboratory, repository: '', fetch: false }), /unowned/);
  f.write(f.laboratory, 'config/laboratory.json', JSON.stringify({ formaSource: { repositoryUrl: f.url, cacheDirectory: '../outside' } }));
  assert.throws(() => sourceConfiguration(f.laboratory), /relative/);
  f.write(f.laboratory, 'config/laboratory.json', JSON.stringify({ formaSource: { repositoryUrl: f.url, cacheDirectory: '.grandprix/linked/cache' } }));
  symlinkSync(f.forma, join(f.laboratory, '.grandprix/linked'));
  assert.throws(() => ensureFormaSource(f.formaCommit, { root: f.laboratory, repository: '', fetch: false }), /symbolic/);
});
test('HTTPS and SSH origins identify the same configured repository without accepting embedded credentials', () => {
  assert.equal(repositoryIdentity('git@github.com:getforma-dev/forma.git'), repositoryIdentity('https://github.com/getforma-dev/forma.git'));
  assert.throws(() => repositoryIdentity('https://user:secret@github.com/getforma-dev/forma.git'));
  assert.throws(() => repositoryIdentity('file:///tmp/source'));
});
