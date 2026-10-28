// Restore exact published evidence after temporary Actions artifacts expire.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { REPOSITORY, WORKFLOWS, runCommand, SAFE_EXTRACT } from './github.mjs';
import { acquire, config, hash, readJSON, runPath, safePath, seal, verify, writeJSON } from './session.mjs';
import { generateReport } from './report.mjs';

const LIMIT = 256 * 1024 ** 2;
const numeric = value => { assert((typeof value === 'string' || Number.isSafeInteger(value)) && /^[1-9]\d{0,19}$/.test(String(value)), 'Exact numeric release identity required'); return String(value); };
const sha = (value, length) => assert(typeof value === 'string' && new RegExp('^[a-f0-9]{' + length + '}$').test(value), 'Exact source or archive digest required');
const text = value => typeof value === 'string' && value.length > 0 && value.length < 256;
function loadCatalog(root, relative) {
  assert.equal(config(root).repository, REPOSITORY, 'Restoration repository differs');
  assert(typeof relative === 'string' && /^evidence\/catalog\/[1-9]\d{0,19}-[1-9]\d{0,19}-[1-9]\d{0,19}\.json$/.test(relative), 'Choose an exact evidence/catalog record');
  const file = safePath(root, relative), stat = fs.statSync(file);
  assert(stat.isFile() && stat.size <= 128 * 1024, 'Catalog must be a bounded regular file');
  const bytes = fs.readFileSync(file), record = JSON.parse(bytes);
  assert.equal(record.schemaVersion, 1); assert.equal(record.kind, 'forma-grand-prix-evidence-archive');
  assert(Object.hasOwn(WORKFLOWS, record.suite), 'Unknown catalog suite');
  const { remote, archive, release, asset, source } = record;
  assert.equal(remote?.repository, REPOSITORY, 'Catalog repository differs');
  const runId = numeric(remote.runId), attempt = numeric(remote.attempt), artifactId = numeric(remote.artifactId);
  assert.equal(relative, `evidence/catalog/${runId}-${attempt}-${artifactId}.json`, 'Catalog filename differs from remote identity');
  assert.equal(remote.workflow, '.github/workflows/' + WORKFLOWS[record.suite].file, 'Catalog workflow differs');
  assert.equal(remote.artifactName, `grand-prix-${record.suite}-${runId}-${attempt}`, 'Catalog artifact name differs');
  assert([`https://github.com/${REPOSITORY}/actions/runs/${runId}`, `https://github.com/${REPOSITORY}/actions/runs/${runId}/attempts/${attempt}`].includes(remote.url), 'Catalog workflow URL differs');
  assert(text(record.status) && text(record.quality), 'Catalog outcome is missing');
  assert(typeof record.observedAt === 'string' && Number.isFinite(Date.parse(record.observedAt)), 'Catalog observation date is invalid');
  sha(archive?.sha256, 64); assert.equal(archive.format, 'original-github-actions-zip');
  assert(Number.isSafeInteger(archive.bytes) && archive.bytes > 0 && archive.bytes <= LIMIT, 'Catalog archive exceeds the download bound');
  sha(source?.laboratoryCommit, 40); sha(source.originalManifestSha256, 64); sha(source.originalSealSha256, 64);
  assert(Array.isArray(source.formaCommits)); source.formaCommits.forEach(commit => sha(commit, 40));
  numeric(release?.id); numeric(asset?.id);
  assert.equal(release.tag, 'evidence-' + new Date(record.observedAt).toISOString().slice(0, 10), 'Catalog release date differs');
  assert.equal(release.url, `https://github.com/${REPOSITORY}/releases/tag/${release.tag}`, 'Catalog release URL differs');
  const assetName = `grand-prix-${record.suite}-${runId}-${attempt}-${artifactId}-${archive.sha256}.zip`;
  assert.equal(asset.name, assetName, 'Catalog asset name differs from exact evidence identity');
  assert.equal(asset.url, `https://github.com/${REPOSITORY}/releases/download/${release.tag}/${assetName}`, 'Catalog asset URL differs');
  return { record, catalogSha256: hash(bytes), runId, attempt, artifactId, localId: `github-${runId}-${attempt}-${artifactId}` };
}
function checkOriginal(directory, record) {
  const checked = verify(directory); assert(checked.ok, 'Original evidence seal failed: ' + checked.problems.join('; '));
  assert.equal(hash(fs.readFileSync(safePath(directory, 'manifest.json'))), record.source.originalManifestSha256, 'Original manifest digest differs from catalog');
  assert.equal(hash(fs.readFileSync(safePath(directory, 'integrity.json'))), record.source.originalSealSha256, 'Original seal digest differs from catalog');
  const original = readJSON(safePath(directory, 'manifest.json'));
  assert.equal(original.remote?.repository, REPOSITORY, 'Original repository differs');
  assert.equal(String(original.remote?.runId), String(record.remote.runId), 'Original run differs');
  assert.equal(String(original.remote?.runAttempt), String(record.remote.attempt), 'Original attempt differs');
  assert.equal(original.labSourceCommit, record.source.laboratoryCommit, 'Original laboratory source differs');
  assert.equal(original.source?.commit, record.source.laboratoryCommit, 'Original source commit differs');
  assert.deepEqual(original.formaSourceCommits || [], record.source.formaCommits, 'Original Forma source differs');
  assert.equal(original.config?.suite, record.suite, 'Original suite differs');
  assert.equal(original.startedAt, record.observedAt, 'Original observation date differs');
  assert.equal(original.status, record.status, 'Original status differs');
  assert.equal(original.quality, record.quality, 'Original quality differs');
  if (record.performanceAcceptance !== undefined) assert.deepEqual(original.performanceAcceptance, record.performanceAcceptance, 'Original performance acceptance differs');
  return { original, checked };
}
function checkExisting(directory, identity) {
  const checked = verify(directory); assert(checked.ok, 'Existing local evidence seal failed: ' + checked.problems.join('; '));
  const manifest = readJSON(safePath(directory, 'manifest.json')), { record, localId, runId, attempt, artifactId } = identity;
  assert.equal(manifest.id, localId); assert.equal(manifest.status, 'imported', 'Existing destination is not a verified import; inspect it before restoring again');
  const remote = manifest.remote;
  assert.equal(remote?.repository, REPOSITORY); assert.equal(String(remote.runId), runId); assert.equal(String(remote.attempt), attempt); assert.equal(String(remote.artifactId), artifactId);
  assert.equal(remote.headSha, record.source.laboratoryCommit); assert.equal(remote.artifactName, record.remote.artifactName);
  assert.equal(remote.archiveSha256, record.archive.sha256, 'Existing import archive identity differs'); assert.equal(remote.workflow, record.remote.workflow);
  assert.equal(manifest.mode, 'remote-evidence'); assert.equal(manifest.quality, 'remote-import');
  assert.equal(manifest.originalStatus, record.status, 'Existing imported status differs'); assert.equal(manifest.originalQuality, record.quality, 'Existing imported quality differs');
  assert.equal(manifest.labSourceCommit, record.source.laboratoryCommit); assert.deepEqual(manifest.formaSourceCommits || [], record.source.formaCommits);
  const bytes = fs.readFileSync(safePath(directory, 'original.zip'));
  assert.equal(bytes.length, record.archive.bytes); assert.equal(hash(bytes), record.archive.sha256, 'Existing archive digest differs');
  const { original } = checkOriginal(safePath(directory, 'artifacts/remote'), record);
  assert.deepEqual(remote.originalManifest, original, 'Existing import original manifest differs');
  return manifest;
}
export async function restoreArchive(root, catalogRelativePath, { command = runCommand, onProgress = () => {} } = {}) {
  const identity = loadCatalog(root, catalogRelativePath), { record, runId, attempt, artifactId } = identity;
  let localId = identity.localId, destination = runPath(root, localId);
  if (fs.existsSync(destination)) {
    const integrity = verify(destination); assert(integrity.ok, 'Existing local evidence seal failed: ' + integrity.problems.join('; '));
    const previous = readJSON(safePath(destination, 'manifest.json'));
    if (previous.status === 'imported') {
      checkExisting(destination, identity);
      return { id: localId, reused: true, restoredFrom: record.asset.url, report: `/runs/${localId}/report.html`, originalStatus: record.status, originalQuality: record.quality };
    }
    assert.equal(previous.status, 'failed', 'Existing restoration is not finished'); assert.equal(previous.id, localId);
    assert.equal(previous.remote?.repository, REPOSITORY); assert.equal(String(previous.remote.runId), runId); assert.equal(String(previous.remote.attempt), attempt); assert.equal(String(previous.remote.artifactId), artifactId);
    assert.equal(previous.remote.archiveSha256, record.archive.sha256); assert.equal(previous.remote.headSha, record.source.laboratoryCommit);
    assert.equal(previous.archiveRestore?.catalog, catalogRelativePath, 'Existing failed record is not this restoration');
    assert.equal(previous.archiveRestore.catalogSha256, identity.catalogSha256, 'Failed restoration catalog identity differs');
    assert.equal(String(previous.archiveRestore.assetId), String(record.asset.id)); assert.equal(String(previous.archiveRestore.releaseId), String(record.release.id));
    localId += '-retry-' + randomUUID().slice(0, 8); destination = runPath(root, localId);
  }
  const releaseLock = acquire(root, localId, { operation: 'import' });
  const scratch = safePath(root, `.grandprix/restores/${randomUUID()}`);
  const call = (args, options = {}) => command('gh', args, { cwd: root, ...options });
  const api = async endpoint => JSON.parse((await call(['api', endpoint])).stdout);
  let manifest;
  try {
    fs.mkdirSync(scratch, { recursive: true }); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.mkdirSync(destination);
    manifest = { schemaVersion: 1, id: localId, status: 'importing', mode: 'remote-evidence', quality: 'unverified-import', startedAt: record.observedAt,
      importedAt: new Date().toISOString(), remote: { repository: REPOSITORY, runId, attempt, artifactId, conclusion: record.remote.conclusion,
        workflow: record.remote.workflow, headSha: record.source.laboratoryCommit, url: record.remote.url, artifactName: record.remote.artifactName,
        archiveSha256: record.archive.sha256, archiveSource: 'github-release' },
      archiveRestore: { catalog: catalogRelativePath, catalogSha256: identity.catalogSha256, releaseId: record.release.id, releaseTag: record.release.tag, assetId: record.asset.id, assetUrl: record.asset.url },
      note: 'Restored from the exact published release archive. This is retained remote evidence, not a new local measurement.' };
    writeJSON(path.join(destination, 'manifest.json'), manifest, true);
    onProgress('Checking the permanent release and exact evidence asset.');
    const release = await api(`repos/${REPOSITORY}/releases/tags/${record.release.tag}`);
    assert.equal(String(release.id), String(record.release.id), 'Release identity differs'); assert.equal(release.tag_name, record.release.tag); assert(!release.draft, 'Release is not published');
    let candidates = [], complete = false;
    for (let page = 1; page <= 20; page++) {
      const assets = await api(`repos/${REPOSITORY}/releases/${numeric(release.id)}/assets?per_page=100&page=${page}`);
      assert(Array.isArray(assets), 'Unexpected release asset response');
      candidates.push(...assets.filter(asset => String(asset.id) === String(record.asset.id) || asset.name === record.asset.name));
      if (assets.length < 100) { complete = true; break; }
    }
    assert(complete, 'Release inventory exceeds the bounded review limit'); assert.equal(candidates.length, 1, 'Exactly one catalog asset must belong to this release');
    const asset = candidates[0]; assert.equal(String(asset.id), String(record.asset.id), 'Release asset identity differs');
    assert.equal(asset.name, record.asset.name, 'Release asset name differs'); assert.equal(asset.browser_download_url, record.asset.url, 'Release asset URL differs');
    assert.equal(asset.state, 'uploaded', 'Release asset upload is incomplete'); assert.equal(asset.size, record.archive.bytes, 'Release asset size differs');
    if (asset.digest) assert.equal(asset.digest, 'sha256:' + record.archive.sha256, 'Release asset digest differs');
    const archive = path.join(scratch, 'original.zip');
    onProgress('Downloading the release archive; no Actions artifact is required.');
    await call(['api', `repos/${REPOSITORY}/releases/assets/${numeric(asset.id)}`, '-H', 'Accept: application/octet-stream'],
      { outputFile: archive, maxBytes: LIMIT, timeout: 180_000, onProgress });
    fs.copyFileSync(archive, path.join(destination, 'original.zip'), fs.constants.COPYFILE_EXCL);
    const bytes = fs.readFileSync(archive);
    assert.equal(bytes.length, record.archive.bytes, 'Downloaded archive size differs'); assert.equal(hash(bytes), record.archive.sha256, 'Downloaded archive digest differs');
    const extracted = path.join(destination, 'artifacts/remote'); fs.mkdirSync(extracted, { recursive: true });
    onProgress('Verifying archive paths, original seals, sources and recorded outcomes.');
    await command('python3', ['-c', SAFE_EXTRACT, archive, extracted], { cwd: root, maxBytes: 1024 ** 2, timeout: 60_000 });
    const { original, checked } = checkOriginal(extracted, record);
    manifest.remote.originalManifest = original; manifest.remote.originalIntegrity = checked;
    for (const field of ['protocolVersion', 'testHash', 'config', 'environment', 'source', 'plan', 'labSourceCommit', 'formaSourceCommits', 'performanceAcceptance']) if (original[field] !== undefined) manifest[field] = original[field];
    manifest.expected = (original.expected || []).map(item => ({ ...item, ...(item.trial ? { trial: 'artifacts/remote/' + item.trial } : {}) }));
    manifest.originalStatus = original.status; manifest.originalQuality = original.quality; manifest.observedAt = original.startedAt;
    manifest.finishedAt = original.finishedAt || original.startedAt; manifest.status = 'imported'; manifest.quality = 'remote-import';
    writeJSON(path.join(destination, 'manifest.json'), manifest); generateReport(destination); seal(destination);
    return { id: localId, reused: false, restoredFrom: record.asset.url, remoteRunId: runId, remoteAttempt: attempt,
      originalStatus: original.status, originalQuality: original.quality, report: `/runs/${localId}/report.html` };
  } catch (error) {
    if (manifest) {
      manifest.status = 'failed'; manifest.quality = 'unverified-import'; manifest.error = error.message; manifest.finishedAt = new Date().toISOString();
      writeJSON(path.join(destination, 'manifest.json'), manifest);
      try { generateReport(destination); seal(destination); } catch (reportError) { manifest.reportError = reportError.message; writeJSON(path.join(destination, 'manifest.json'), manifest); try { seal(destination); } catch {} }
    }
    throw error;
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); releaseLock(); }
}
