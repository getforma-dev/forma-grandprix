import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archivePlan, publishArchive } from '../src/archive.mjs';
import { readControlCatalog } from '../src/control-server.mjs';
import { execFileSync } from 'node:child_process';
import { REPOSITORY, runCommand } from '../src/github.mjs';
import { hash, readJSON, seal, writeJSON } from '../src/session.mjs';

const source = 'a'.repeat(40), anchor = 'b'.repeat(40);
function fixture(t, originalFields = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-archive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeJSON(path.join(root, 'config/laboratory.json'), { repository: REPOSITORY });
  const id = 'github-123-1-456', dir = path.join(root, 'runs', id), nested = path.join(dir, 'artifacts/remote');
  const original = { id: 'client-123-1', status: 'failed', quality: 'unqualified', startedAt: '2026-10-28T12:00:00Z',
    config: { suite: 'client' }, source: { commit: source }, labSourceCommit: source, formaSourceCommits: ['c'.repeat(40)],
    remote: { repository: REPOSITORY, runId: '123', runAttempt: '1' } };
  Object.assign(original, originalFields);
  writeJSON(path.join(nested, 'manifest.json'), original); fs.writeFileSync(path.join(nested, 'run.log'), 'original failed attempt'); seal(nested);
  const zipPath = path.join(dir, 'original.zip');
  execFileSync('python3', ['-c', "import pathlib,sys,zipfile\nroot=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],'w') as z:\n for f in root.rglob('*'):\n  if f.is_file():z.write(f,f.relative_to(root))", nested, zipPath]);
  const zip = fs.readFileSync(zipPath);
  const digest = hash(zip), manifest = { id, status: 'imported', quality: 'remote-import', remote: { repository: REPOSITORY, runId: 123, attempt: 1, artifactId: 456,
    artifactName: 'grand-prix-client-123-1', workflow: '.github/workflows/grand-prix-client.yml', headSha: source, conclusion: 'failure',
    archiveSha256: digest, advertisedDigest: 'sha256:' + digest, originalManifest: original } };
  writeJSON(path.join(dir, 'manifest.json'), manifest); seal(dir);
  const state = { main: anchor, release: null, assets: [], calls: [], digest, zip, missingDigest: false, deny: null, existingTag: false, uploaded: null };
  const command = async (program, args, options = {}) => {
    if (program === 'python3') return runCommand(program, args, options);
    assert.equal(program, 'gh'); state.calls.push({ args, options });
    const endpoint = args[1];
    if (state.deny && endpoint.includes(state.deny)) throw Error('gh: denied (HTTP 403)');
    const out = value => ({ stdout: JSON.stringify(value) });
    if (args[0] === 'api') {
      if (endpoint.endsWith('/actions/runs/123/attempts/1')) return out({ id: 123, run_attempt: 1, status: 'completed', head_sha: source, path: manifest.remote.workflow });
      if (endpoint.endsWith('/actions/artifacts/456')) return out({ id: 456, name: manifest.remote.artifactName, workflow_run: { id: 123 }, size_in_bytes: zip.length, digest: 'sha256:' + digest });
      if (endpoint.endsWith('/git/ref/heads/main')) return out({ object: { type: 'commit', sha: state.main } });
      if (endpoint.includes('/releases/tags/')) { if (state.release) return out(state.release); throw Error('gh: Not Found (HTTP 404)'); }
      if (endpoint.includes('/git/ref/tags/')) { if (state.existingTag) return out({ object: { sha: anchor } }); throw Error('gh: Not Found (HTTP 404)'); }
      if (endpoint.includes('/releases/789/assets?')) return out(state.assets);
      if (endpoint.endsWith('/releases/assets/987')) { fs.writeFileSync(options.outputFile, state.zip); return { stdout: '' }; }
      throw Error('Unexpected endpoint: ' + endpoint);
    }
    if (args[0] === 'release' && args[1] === 'create') {
      state.release = { id: 789, tag_name: args[2], target_commitish: args[args.indexOf('--target') + 1], draft: false, html_url: `https://github.com/${REPOSITORY}/releases/tag/${args[2]}` };
      return { stdout: '' };
    }
    if (args[0] === 'release' && args[1] === 'upload') {
      assert(!args.includes('--clobber')); state.uploaded = fs.readFileSync(args[3]);
      assert.deepEqual(state.uploaded, zip); const name = path.basename(args[3]);
      state.assets.push({ id: 987, name, size: zip.length, state: 'uploaded', digest: state.missingDigest ? null : 'sha256:' + digest,
        browser_download_url: `https://github.com/${REPOSITORY}/releases/download/${args[2]}/${name}` });
      return { stdout: '' };
    }
    throw Error('Unexpected command: ' + args.join(' '));
  };
  return { root, id, dir, nested, original, manifest, state, command };
}
const mutations = state => state.calls.filter(call => call.args[0] === 'release');
test('plan verifies both seals, exact ZIP and remote identity without mutating files or GitHub', async t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.dir, 'integrity.json'));
  const plan = await archivePlan(f.root, f.id, f);
  assert.equal(plan.archiveSha256, f.state.digest); assert.equal(plan.tag, 'evidence-2026-10-28');
  assert.equal(plan.releaseTargetCommit, anchor); assert.equal(plan.sourceCommit, source);
  assert.equal(plan.status, 'failed'); assert.equal(plan.quality, 'unqualified');
  assert.equal(plan.catalogPath, 'evidence/catalog/123-1-456.json');
  assert.equal(mutations(f.state).length, 0); assert(!fs.existsSync(path.join(f.root, 'evidence')));
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'integrity.json')), before);
});
test('explicit publication uploads exact ZIP and writes one small immutable catalog; repeated use reuses assets', async t => {
  const f = fixture(t), plan = await archivePlan(f.root, f.id, f), result = await publishArchive(f.root, plan, f);
  assert(result.published); assert(!result.reused); assert.deepEqual(f.state.uploaded, f.state.zip);
  const catalogFile = path.join(f.root, result.catalog), bytes = fs.readFileSync(catalogFile), record = JSON.parse(bytes);
  assert(bytes.length < 5000); assert.equal(record.archive.sha256, f.state.digest);
  assert.equal(record.source.laboratoryCommit, source); assert.equal(record.release.target, anchor);
  assert.equal(record.status, 'failed'); assert.equal(record.quality, 'unqualified');
  assert.equal(record.remote.runId, '123'); assert.equal(record.remote.attempt, '1');
  const displayed = readControlCatalog(f.root); assert.deepEqual(displayed.catalogErrors, []); assert.equal(displayed.catalog.length, 1); assert.deepEqual(displayed.catalog[0], record);
  assert(!fs.existsSync(path.join(f.root, '.grandprix/active.json')));
  assert(!fs.readdirSync(path.join(f.root, 'evidence/catalog')).some(name => name.endsWith('.zip')));
  assert.equal(mutations(f.state).length, 2);
  const second = await publishArchive(f.root, await archivePlan(f.root, f.id, f), f);
  assert(second.reused); assert.equal(mutations(f.state).length, 2); assert.deepEqual(fs.readFileSync(catalogFile), bytes);
});
test('existing daily release preserves unrelated assets and never edits the release', async t => {
  const f = fixture(t);
  f.state.release = { id: 789, tag_name: 'evidence-2026-10-28', target_commitish: 'd'.repeat(40), draft: false };
  f.state.assets = [{ id: 888, name: 'unrelated-evidence.zip', size: 1 }];
  await publishArchive(f.root, await archivePlan(f.root, f.id, f), f);
  assert.equal(f.state.assets[0].name, 'unrelated-evidence.zip'); assert.equal(mutations(f.state).length, 1);
  assert.equal(mutations(f.state)[0].args[1], 'upload');
});
test('missing GitHub release digest triggers exact downloaded-byte verification', async t => {
  const f = fixture(t); f.state.missingDigest = true;
  await publishArchive(f.root, await archivePlan(f.root, f.id, f), f);
  assert(f.state.calls.some(call => call.args[1].endsWith('/releases/assets/987')));
});
test('tampering, nested-seal failure and unverified imports fail before any network write', async t => {
  for (const mutate of [
    f => fs.appendFileSync(path.join(f.dir, 'original.zip'), 'tamper'),
    f => { fs.appendFileSync(path.join(f.nested, 'run.log'), 'tamper'); seal(f.dir); },
    f => { f.manifest.status = 'failed'; writeJSON(path.join(f.dir, 'manifest.json'), f.manifest); seal(f.dir); },
    f => { f.manifest.remote.archiveSha256 = '0'.repeat(64); writeJSON(path.join(f.dir, 'manifest.json'), f.manifest); seal(f.dir); },
    f => { f.manifest.remote.repository = 'foreign/repo'; writeJSON(path.join(f.dir, 'manifest.json'), f.manifest); seal(f.dir); },
  ]) { const f = fixture(t); mutate(f); await assert.rejects(archivePlan(f.root, f.id, f)); assert.equal(mutations(f.state).length, 0); }
});
test('stale review plans and conflicting immutable remote assets are refused', async t => {
  const f = fixture(t), plan = await archivePlan(f.root, f.id, f); f.state.main = 'e'.repeat(40);
  await assert.rejects(publishArchive(f.root, plan, f), /plan changed/); assert.equal(mutations(f.state).length, 0);
  f.state.release = { id: 789, tag_name: plan.tag, draft: false, target_commitish: anchor };
  f.state.assets = [{ id: 987, name: plan.assetPrefix + '0'.repeat(64) + '.zip', size: plan.archiveBytes, state: 'uploaded' }];
  await assert.rejects(archivePlan(f.root, f.id, f), /collision/);
});
test('permission errors and orphaned tags do not become release creation permissions', async t => {
  const f = fixture(t); f.state.deny = '/releases/tags/'; await assert.rejects(archivePlan(f.root, f.id, f), /HTTP 403/);
  f.state.deny = null; f.state.existingTag = true; await assert.rejects(archivePlan(f.root, f.id, f), /tag already exists/);
  assert.equal(mutations(f.state).length, 0);
});
test('published download mismatch keeps catalog absent and releases the archive lock', async t => {
  const f = fixture(t); f.state.missingDigest = true;
  const command = async (program, args, options) => {
    const result = await f.command(program, args, options);
    if (args[1].endsWith('/releases/assets/987')) fs.writeFileSync(options.outputFile, 'changed downloaded bytes');
    return result;
  };
  const options = { command }, plan = await archivePlan(f.root, f.id, options);
  await assert.rejects(publishArchive(f.root, plan, options), /byte count differs|digest differs/);
  assert(!fs.existsSync(path.join(f.root, plan.catalogPath))); assert(!fs.existsSync(path.join(f.root, '.grandprix/active.json')));
});

test('resealing changed extracted records cannot relabel the exact original ZIP', async t => {
  const f = fixture(t); f.original.quality = 'qualified';
  writeJSON(path.join(f.nested, 'manifest.json'), f.original); seal(f.nested);
  writeJSON(path.join(f.dir, 'manifest.json'), f.manifest); seal(f.dir);
  await assert.rejects(archivePlan(f.root, f.id, f), /differs from the exact original ZIP/);
  assert.equal(f.state.calls.length, 0);
});

test('catalog preserves original budget misses separately from qualified evidence and refuses rewritten acceptance', async t => {
  const acceptance = { applicable: true, status: 'missed', onlyFailure: true, diagnostic: false,
    measured: { peakMiB: 8.01 }, limits: { peakMiB: 8 }, checks: [{ metric: 'peakMiB', limit: 8, measured: 8.01, passed: false }],
    evidence: 'artifacts/raw/forma-budgets.json', phaseReceipt: 'artifacts/ci-phases.json' };
  const f = fixture(t, { status: 'failed', quality: 'qualified', performanceAcceptance: acceptance });
  f.manifest.performanceAcceptance = { status: 'met' }; writeJSON(path.join(f.dir, 'manifest.json'), f.manifest); seal(f.dir);
  const plan = await archivePlan(f.root, f.id, f); assert.deepEqual(plan.performanceAcceptance, acceptance);
  const result = await publishArchive(f.root, plan, f), file = path.join(f.root, result.catalog), record = readJSON(file);
  assert.equal(record.status, 'failed'); assert.equal(record.quality, 'qualified'); assert.deepEqual(record.performanceAcceptance, acceptance);
  record.performanceAcceptance.status = 'met'; writeJSON(file, record);
  await assert.rejects(publishArchive(f.root, await archivePlan(f.root, f.id, f), f), /Immutable catalog observation differs: performanceAcceptance/);
  assert.equal(mutations(f.state).length, 2);
});
test('older archives without acceptance metadata remain unclassified and unchanged', async t => {
  const f = fixture(t), plan = await archivePlan(f.root, f.id, f);
  assert(!Object.hasOwn(plan, 'performanceAcceptance'));
  const result = await publishArchive(f.root, plan, f), record = readJSON(path.join(f.root, result.catalog));
  assert(!Object.hasOwn(record, 'performanceAcceptance'));
});
