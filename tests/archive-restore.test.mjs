import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { restoreArchive } from '../src/archive-restore.mjs';
import { REPOSITORY, runCommand } from '../src/github.mjs';
import { hash, readJSON, seal, verify, writeJSON } from '../src/session.mjs';

const source = 'a'.repeat(40), forma = 'b'.repeat(40);
function fixture(t, { originalChange = () => {}, extraMembers = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-restore-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeJSON(path.join(root, 'config/laboratory.json'), { repository: REPOSITORY });
  const originalDir = path.join(root, 'remote-source'), archive = path.join(root, 'remote.zip');
  const original = { id: 'client-123-1', status: 'failed', quality: 'unqualified', startedAt: '2026-10-28T12:00:00Z', finishedAt: '2026-10-28T12:01:00Z',
    config: { suite: 'client' }, source: { commit: source }, labSourceCommit: source, formaSourceCommits: [forma],
    expected: [{ event: 'dom', car: 'forma', trial: 'artifacts/trial-a' }], remote: { repository: REPOSITORY, runId: '123', runAttempt: '1' },
    performanceAcceptance: { applicable: true, status: 'missed', onlyFailure: false, measured: { peakMiB: 8.1 }, limits: { peakMiB: 8 } } };
  originalChange(original);
  writeJSON(path.join(originalDir, 'manifest.json'), original); fs.writeFileSync(path.join(originalDir, 'run.log'), 'retained failed attempt'); seal(originalDir);
  execFileSync('python3', ['-c', "import pathlib,sys,zipfile,json\nroot=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],'w') as z:\n for f in root.rglob('*'):\n  if f.is_file():z.write(f,f.relative_to(root))\n for name,value in json.loads(sys.argv[3]).items():z.writestr(name,value)", originalDir, archive, JSON.stringify(extraMembers)]);
  const zip = fs.readFileSync(archive), digest = hash(zip), tag = 'evidence-2026-10-28', assetName = `grand-prix-client-123-1-456-${digest}.zip`;
  const record = { schemaVersion: 1, kind: 'forma-grand-prix-evidence-archive', suite: 'client', observedAt: '2026-10-28T12:00:00Z', status: 'failed', quality: 'unqualified',
    performanceAcceptance: original.performanceAcceptance,
    remote: { repository: REPOSITORY, runId: '123', attempt: '1', artifactId: '456', artifactName: 'grand-prix-client-123-1', workflow: '.github/workflows/grand-prix-client.yml', conclusion: 'failure', url: `https://github.com/${REPOSITORY}/actions/runs/123/attempts/1` },
    source: { laboratoryCommit: source, formaCommits: [forma], originalManifestSha256: hash(fs.readFileSync(path.join(originalDir, 'manifest.json'))), originalSealSha256: hash(fs.readFileSync(path.join(originalDir, 'integrity.json'))) },
    archive: { sha256: digest, bytes: zip.length, format: 'original-github-actions-zip' },
    release: { id: 789, tag, url: `https://github.com/${REPOSITORY}/releases/tag/${tag}` },
    asset: { id: 987, name: assetName, url: `https://github.com/${REPOSITORY}/releases/download/${tag}/${assetName}` } };
  const relative = 'evidence/catalog/123-1-456.json', save = () => writeJSON(path.join(root, relative), record); save();
  const state = { calls: [], zip, asset: { id: 987, name: assetName, size: zip.length, digest: 'sha256:' + digest, state: 'uploaded', browser_download_url: record.asset.url },
    release: { id: 789, tag_name: tag, draft: false }, failure: null };
  const command = async (program, args, options = {}) => {
    state.calls.push({ program, args, options });
    if (program === 'python3') return runCommand(program, args, options);
    assert.equal(program, 'gh'); assert.equal(args[0], 'api');
    assert(!args[1].includes('/actions/'), 'Expired Actions APIs must never be consulted');
    if (state.failure) throw Error(state.failure);
    if (args[1].endsWith('/releases/tags/' + tag)) return { stdout: JSON.stringify(state.release) };
    if (args[1].includes('/releases/789/assets?')) return { stdout: JSON.stringify([state.asset]) };
    if (args[1].endsWith('/releases/assets/987')) {
      assert(args.includes('Accept: application/octet-stream')); assert.equal(options.maxBytes, 256 * 1024 ** 2);
      fs.writeFileSync(options.outputFile, state.zip); return { stdout: '' };
    }
    throw Error('Unexpected request: ' + args[1]);
  };
  return { root, relative, record, save, state, original, command, id: 'github-123-1-456', directory: path.join(root, 'runs/github-123-1-456') };
}
test('release-only restoration retains original identity, failed outcome, acceptance and readable sealed reports', async t => {
  const f = fixture(t), result = await restoreArchive(f.root, f.relative, f);
  assert.equal(result.id, f.id); assert.equal(result.report, `/runs/${f.id}/report.html`); assert(!result.reused);
  const manifest = readJSON(path.join(f.directory, 'manifest.json'));
  assert.equal(manifest.status, 'imported'); assert.equal(manifest.quality, 'remote-import'); assert.equal(manifest.originalStatus, 'failed'); assert.equal(manifest.originalQuality, 'unqualified');
  assert.deepEqual(manifest.remote.originalManifest, f.original); assert.deepEqual(manifest.performanceAcceptance, f.original.performanceAcceptance);
  assert.equal(manifest.expected[0].trial, 'artifacts/remote/artifacts/trial-a');
  assert.equal(manifest.archiveRestore.catalog, f.relative); assert.equal(manifest.remote.headSha, source);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'original.zip')), f.state.zip);
  assert.equal(verify(f.directory).ok, true); assert.equal(verify(path.join(f.directory, 'artifacts/remote')).ok, true);
  for (const name of ['report.html','report.md','report.json','measurements.csv']) assert(fs.existsSync(path.join(f.directory, name)));
  assert(!fs.existsSync(path.join(f.root, '.grandprix/active.json'))); assert.equal(fs.readdirSync(path.join(f.root, '.grandprix/restores')).length, 0);
  const callCount = f.state.calls.length, again = await restoreArchive(f.root, f.relative, f);
  assert(again.reused); assert.equal(f.state.calls.length, callCount);
});
test('download corruption retains a sealed failed attempt and valid retry never overwrites it', async t => {
  const f = fixture(t), correct = f.state.zip; f.state.zip = Buffer.from(correct); f.state.zip[0] ^= 1;
  await assert.rejects(restoreArchive(f.root, f.relative, f), /digest differs/);
  const before = fs.readFileSync(path.join(f.directory, 'manifest.json'));
  assert.equal(JSON.parse(before).status, 'failed'); assert.equal(verify(f.directory).ok, true);
  assert(!fs.existsSync(path.join(f.directory, 'artifacts/remote')));
  f.state.zip = correct; const retry = await restoreArchive(f.root, f.relative, f);
  assert.match(retry.id, /^github-123-1-456-retry-[a-f0-9]{8}$/);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'manifest.json')), before);
  assert.equal(verify(path.join(f.root, 'runs', retry.id)).ok, true);
});
test('wrong original source, attempt, status, quality and acceptance cannot be relabeled from a catalog', async t => {
  for (const [change, pattern] of [
    [m => { m.labSourceCommit = 'c'.repeat(40); }, /laboratory source differs/],
    [m => { m.remote.runAttempt = '2'; }, /attempt differs/],
    [m => { m.status = 'completed'; }, /status differs/],
    [m => { m.quality = 'qualified'; }, /quality differs/],
  ]) {
    const f = fixture(t, { originalChange: change }); await assert.rejects(restoreArchive(f.root, f.relative, f), pattern);
    assert.equal(readJSON(path.join(f.directory, 'manifest.json')).status, 'failed'); assert.equal(verify(f.directory).ok, true);
  }
  const f = fixture(t); f.record.performanceAcceptance = { status: 'met' }; f.save();
  await assert.rejects(restoreArchive(f.root, f.relative, f), /performance acceptance differs/);
});
test('unsafe ZIP traversal is refused before any archive member is extracted', async t => {
  const f = fixture(t, { extraMembers: { '../escaped.txt': 'must never be written' } });
  await assert.rejects(restoreArchive(f.root, f.relative, f), /unsafe archive path/);
  assert.deepEqual(fs.readdirSync(path.join(f.directory, 'artifacts/remote')), []);
  assert(!fs.existsSync(path.join(f.directory, 'artifacts/escaped.txt'))); assert.equal(verify(f.directory).ok, true);
});
test('wrong release identity or asset binding fails and retains failure without downloading', async t => {
  for (const mutate of [
    f => { f.state.release.id = 800; }, f => { f.state.release.tag_name = 'other'; },
    f => { f.state.asset.id = 999; }, f => { f.state.asset.name = 'other.zip'; },
    f => { f.state.asset.digest = 'sha256:' + '0'.repeat(64); }, f => { f.state.asset.size++; },
  ]) {
    const f = fixture(t); mutate(f); await assert.rejects(restoreArchive(f.root, f.relative, f));
    assert(!f.state.calls.some(call => call.args[1]?.endsWith('/releases/assets/987')));
    assert.equal(verify(f.directory).ok, true); assert(!fs.existsSync(path.join(f.root, '.grandprix/active.json')));
  }
});
test('bad catalog paths, foreign repository, oversized archive and altered catalog digests fail closed', async t => {
  const f = fixture(t);
  for (const value of ['../catalog.json','evidence/catalog/../123-1-456.json','/absolute/123-1-456.json']) await assert.rejects(restoreArchive(f.root, value, f));
  f.record.remote.repository = 'foreign/repository'; f.save(); await assert.rejects(restoreArchive(f.root, f.relative, f), /repository differs/);
  assert.equal(f.state.calls.length, 0);
  const large = fixture(t); large.record.archive.bytes = 257 * 1024 ** 2; large.save(); await assert.rejects(restoreArchive(large.root, large.relative, large), /bound/); assert.equal(large.state.calls.length, 0);
  const changed = fixture(t); changed.record.source.originalManifestSha256 = '0'.repeat(64); changed.save(); await assert.rejects(restoreArchive(changed.root, changed.relative, changed), /manifest digest differs/);
});
test('tampered or mismatched existing evidence cannot be reused or hidden behind a retry', async t => {
  const f = fixture(t); await restoreArchive(f.root, f.relative, f); fs.appendFileSync(path.join(f.directory, 'report.md'), 'tamper');
  await assert.rejects(restoreArchive(f.root, f.relative, f), /seal failed/); assert.equal(fs.readdirSync(path.join(f.root, 'runs')).length, 1);
  const g = fixture(t); g.state.failure = 'temporary network failure'; await assert.rejects(restoreArchive(g.root, g.relative, g));
  const manifest = readJSON(path.join(g.directory, 'manifest.json')); manifest.remote.artifactId = '999'; writeJSON(path.join(g.directory, 'manifest.json'), manifest); seal(g.directory);
  await assert.rejects(restoreArchive(g.root, g.relative, g)); assert.equal(fs.readdirSync(path.join(g.root, 'runs')).length, 1);
});

test('resealed existing wrappers with incorrect original outcomes cannot be reused', async t => {
 const f = fixture(t); await restoreArchive(f.root, f.relative, f);
 const manifest = readJSON(path.join(f.directory, 'manifest.json')); manifest.originalQuality = 'qualified';
 writeJSON(path.join(f.directory, 'manifest.json'), manifest); seal(f.directory);
 await assert.rejects(restoreArchive(f.root, f.relative, f), /Existing imported quality differs/);
 assert.equal(fs.readdirSync(path.join(f.root, 'runs')).length, 1);
});
