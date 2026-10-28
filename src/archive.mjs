// Durable, explicit evidence publication. Exact imported ZIPs live in Releases;
// Git retains only small immutable catalog records, never regenerated archives.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { REPOSITORY, WORKFLOWS, runCommand } from './github.mjs';
import { acquire, config, hash, readJSON, runPath, safePath, verify, writeJSON } from './session.mjs';

const numberId = value => { const text = String(value); assert(/^[1-9]\d{0,19}$/.test(text), 'Exact numeric GitHub identity required'); return text; };
const exactSha = value => assert(/^[a-f0-9]{40}$/.test(value ?? ''), 'Exact source commit required');
const sha256 = value => assert(/^[a-f0-9]{64}$/.test(value ?? ''), 'Exact archive SHA-256 required');
const ZIP_IDENTITY = `import zipfile,hashlib,json,sys
with zipfile.ZipFile(sys.argv[1]) as z:
 names=z.namelist();assert len(names)==len(set(names)),'duplicate ZIP member'
 result={}
 for name in ['manifest.json','integrity.json']:
  info=z.getinfo(name);assert info.file_size<=16*1024*1024,'oversized ZIP identity record'
  result[name]=hashlib.sha256(z.read(name)).hexdigest()
 print(json.dumps(result))`;
const client = (root, command) => async (args, options = {}) => command('gh', args, { cwd: root, ...options });
const json = async (call, endpoint) => JSON.parse((await call(['api', endpoint])).stdout);
async function optional(call, endpoint) {
  try { return await json(call, endpoint); }
  catch (error) { if (/HTTP 404/.test(error.message)) return null; throw error; }
}
function localEvidence(root, localRunId) {
  assert.equal(config(root).repository, REPOSITORY, 'Evidence publication repository differs');
  const directory = runPath(root, localRunId), integrity = verify(directory);
  assert(integrity.ok, 'Local imported evidence seal failed: ' + integrity.problems.join('; '));
  const manifest = readJSON(safePath(directory, 'manifest.json'));
  assert.equal(manifest.id, localRunId, 'Local run identity differs');
  assert.equal(manifest.status, 'imported', 'Only a verified GitHub import can be archived');
  const remote = manifest.remote;
  assert.equal(remote?.repository, REPOSITORY, 'Imported repository differs');
  const runId = numberId(remote.runId), attempt = numberId(remote.attempt), artifactId = numberId(remote.artifactId);
  const suite = Object.entries(WORKFLOWS).find(([, workflow]) => remote.workflow === '.github/workflows/' + workflow.file)?.[0];
  assert(suite, 'Imported workflow is not registered');
  assert.equal(remote.artifactName, `grand-prix-${suite}-${runId}-${attempt}`, 'Imported artifact name differs');
  exactSha(remote.headSha); sha256(remote.archiveSha256);
  const archive = safePath(directory, 'original.zip'), bytes = fs.readFileSync(archive), digest = hash(bytes);
  assert(bytes.length > 0 && bytes.length <= 256 * 1024 ** 2, 'Archive size exceeds the retained artifact bound');
  assert.equal(digest, remote.archiveSha256, 'Original ZIP differs from imported digest');
  if (remote.advertisedDigest) assert.equal(remote.advertisedDigest, 'sha256:' + digest, 'Original ZIP differs from advertised GitHub digest');
  const originalDirectory = safePath(directory, 'artifacts/remote'), originalIntegrity = verify(originalDirectory);
  assert(originalIntegrity.ok, 'Original evidence seal failed: ' + originalIntegrity.problems.join('; '));
  const original = readJSON(safePath(originalDirectory, 'manifest.json'));
  assert.deepEqual(original, remote.originalManifest, 'Original manifest differs from the verified import record');
  assert.equal(original.remote?.repository, REPOSITORY); assert.equal(String(original.remote?.runId), runId); assert.equal(String(original.remote?.runAttempt), attempt);
  assert.equal(original.source?.commit, remote.headSha); assert.equal(original.labSourceCommit, remote.headSha);
  const observedAt = original.startedAt;
  assert(typeof observedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(observedAt) && Number.isFinite(Date.parse(observedAt)), 'Original observation date required');
  const date = new Date(observedAt).toISOString().slice(0, 10), tag = 'evidence-' + date;
  const prefix = `grand-prix-${suite}-${runId}-${attempt}-${artifactId}-`, assetName = prefix + digest + '.zip';
  return { localRunId, repository: REPOSITORY, runId, attempt, artifactId, suite, workflow: remote.workflow,
    archive, archiveSha256: digest, archiveBytes: bytes.length, artifactName: remote.artifactName, assetName, assetPrefix: prefix,
    tag, observedAt, sourceCommit: remote.headSha, formaSourceCommits: original.formaSourceCommits || [],
    status: original.status, quality: original.quality, workflowConclusion: remote.conclusion,
    ...(original.performanceAcceptance !== undefined ? { performanceAcceptance: original.performanceAcceptance } : {}),
    workflowUrl: `https://github.com/${REPOSITORY}/actions/runs/${runId}/attempts/${attempt}`,
    catalogPath: `evidence/catalog/${runId}-${attempt}-${artifactId}.json`,
    localSealSha256: hash(fs.readFileSync(path.join(directory, 'integrity.json'))),
    originalSealSha256: hash(fs.readFileSync(path.join(originalDirectory, 'integrity.json'))),
    originalManifestSha256: hash(fs.readFileSync(path.join(originalDirectory, 'manifest.json'))),
    checkedFiles: { imported: integrity.checked, original: originalIntegrity.checked } };
}
async function releaseAssets(call, releaseId) {
  const found = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await json(call, `repos/${REPOSITORY}/releases/${numberId(releaseId)}/assets?per_page=100&page=${page}`);
    assert(Array.isArray(batch), 'Unexpected release asset response'); found.push(...batch);
    if (batch.length < 100) return found;
  }
  throw Error('Release inventory exceeds the bounded review limit');
}
async function releaseState(call, evidence) {
  const release = await optional(call, `repos/${REPOSITORY}/releases/tags/${evidence.tag}`);
  if (!release) {
    const existingTag = await optional(call, `repos/${REPOSITORY}/git/ref/tags/${evidence.tag}`);
    assert(!existingTag, 'Evidence tag already exists without a release; inspect it before publication');
    return { release: null, asset: null };
  }
  numberId(release.id); assert.equal(release.tag_name, evidence.tag); assert(!release.draft, 'Existing evidence release is a draft; inspect it before publication');
  const assets = await releaseAssets(call, release.id), matching = assets.filter(asset => asset.name.startsWith(evidence.assetPrefix));
  assert(matching.length <= 1, 'Multiple assets claim this exact run/attempt/artifact');
  const asset = matching[0] || null;
  if (asset) {
    numberId(asset.id); assert.equal(asset.name, evidence.assetName, 'Immutable evidence asset collision: digest differs');
    assert.equal(asset.size, evidence.archiveBytes, 'Immutable evidence asset size differs');
    assert.equal(asset.state, 'uploaded', 'Evidence asset upload is incomplete');
    if (asset.digest) assert.equal(asset.digest, 'sha256:' + evidence.archiveSha256, 'Immutable evidence asset digest differs');
  }
  return { release: { id: release.id, tag: release.tag_name, url: release.html_url, target: release.target_commitish }, asset };
}
export async function archivePlan(root, localRunId, { command = runCommand } = {}) {
  const evidence = localEvidence(root, localRunId), call = client(root, command);
  const zipped = JSON.parse((await command('python3', ['-c', ZIP_IDENTITY, evidence.archive], { cwd: root, timeout: 30_000, maxBytes: 1024 ** 2 })).stdout);
  assert.equal(zipped['manifest.json'], evidence.originalManifestSha256, 'Retained manifest differs from the exact original ZIP');
  assert.equal(zipped['integrity.json'], evidence.originalSealSha256, 'Retained seal differs from the exact original ZIP');
  const run = await json(call, `repos/${REPOSITORY}/actions/runs/${evidence.runId}/attempts/${evidence.attempt}`);
  assert.equal(String(run.id), evidence.runId); assert.equal(String(run.run_attempt), evidence.attempt);
  assert.equal(run.status, 'completed', 'Only completed remote attempts can be archived');
  assert.equal(run.head_sha, evidence.sourceCommit, 'GitHub attempt source differs'); assert.equal(run.path, evidence.workflow, 'GitHub workflow differs');
  const artifact = await json(call, `repos/${REPOSITORY}/actions/artifacts/${evidence.artifactId}`);
  assert.equal(String(artifact.id), evidence.artifactId); assert.equal(artifact.name, evidence.artifactName);
  assert.equal(String(artifact.workflow_run?.id), evidence.runId, 'GitHub artifact run differs');
  assert.equal(artifact.size_in_bytes, evidence.archiveBytes, 'GitHub artifact size differs');
  if (artifact.digest) assert.equal(artifact.digest, 'sha256:' + evidence.archiveSha256, 'GitHub artifact digest differs');
  const main = await json(call, `repos/${REPOSITORY}/git/ref/heads/main`);
  assert.equal(main.object?.type, 'commit', 'Main must resolve to a commit'); exactSha(main.object.sha);
  const state = await releaseState(call, evidence);
  const catalogFile = safePath(root, evidence.catalogPath);
  if (fs.existsSync(catalogFile)) {
    const previous = readJSON(catalogFile);
    assert.equal(previous.archive?.sha256, evidence.archiveSha256, 'Catalog collision: archive digest differs');
    assert.equal(String(previous.remote?.artifactId), evidence.artifactId, 'Catalog collision: artifact differs');
    assert(state.asset && String(previous.asset?.id) === String(state.asset.id), 'Catalog asset is missing or replaced remotely; inspect before proceeding');
  }
  const identity = { ...evidence, releaseTargetCommit: main.object.sha, releaseId: state.release?.id ?? null, assetId: state.asset?.id ?? null };
  return { schemaVersion: 1, operation: 'archive-evidence', ...evidence, releaseTargetCommit: main.object.sha,
    existingRelease: state.release, existingAsset: state.asset ? { id: state.asset.id, name: state.asset.name, digest: state.asset.digest || null, url: state.asset.browser_download_url } : null,
    fingerprint: hash(JSON.stringify(identity)), preparedAt: new Date().toISOString(),
    actions: [state.release ? 'Preserve the existing daily evidence release and every existing asset.' : `Create the daily evidence release ${evidence.tag}, anchored to main commit ${main.object.sha}.`,
      state.asset ? 'Verify the existing exact archive asset; never overwrite it.' : `Upload the exact original ZIP as ${evidence.assetName}; never overwrite an asset.`,
      `Write the compact immutable catalog record ${evidence.catalogPath}; the ZIP remains outside Git.`] };
}
export async function publishArchive(root, plan, { command = runCommand } = {}) {
  assert.equal(plan?.schemaVersion, 1); assert.equal(plan.operation, 'archive-evidence', 'A prepared archive plan is required');
  const fresh = await archivePlan(root, plan.localRunId, { command });
  assert.equal(fresh.fingerprint, plan.fingerprint, 'Archive plan changed; review a fresh plan before publishing');
  const call = client(root, command), releaseLock = acquire(root, plan.localRunId, { operation: 'archive' });
  const scratch = safePath(root, `.grandprix/archive/${randomUUID()}`);
  try {
    fs.mkdirSync(scratch, { recursive: true });
    const staged = path.join(scratch, fresh.assetName);
    fs.copyFileSync(fresh.archive, staged, fs.constants.COPYFILE_EXCL);
    assert.equal(hash(fs.readFileSync(staged)), fresh.archiveSha256, 'Archive changed while staging publication');
    if (!fresh.existingRelease) {
      await call(['release', 'create', fresh.tag, '--repo', REPOSITORY, '--target', fresh.releaseTargetCommit,
        '--title', `Forma Grand Prix evidence — ${fresh.tag.slice(9)}`, '--latest=false', '--notes',
        'Immutable evidence archives from completed Forma Grand Prix attempts, including failures. Each asset retains the exact workflow ZIP and its original source, measurement and integrity records. The versioned evidence/catalog entries record SHA-256 digests and provenance. Release assets are independent of temporary Actions artifact retention.']);
    }
    let state = await releaseState(call, fresh);
    assert(state.release, 'Evidence release was not created');
    if (!state.asset) {
      await call(['release', 'upload', fresh.tag, staged, '--repo', REPOSITORY], { timeout: 180_000 });
      state = await releaseState(call, fresh);
    }
    assert(state.asset, 'Evidence asset was not returned after upload');
    const asset = state.asset;
    if (!asset.digest) {
      const downloaded = path.join(scratch, 'verify-download.zip');
      await call(['api', `repos/${REPOSITORY}/releases/assets/${numberId(asset.id)}`, '-H', 'Accept: application/octet-stream'],
        { outputFile: downloaded, timeout: 180_000, maxBytes: 256 * 1024 ** 2 });
      assert.equal(fs.statSync(downloaded).size, fresh.archiveBytes, 'Published asset byte count differs');
      assert.equal(hash(fs.readFileSync(downloaded)), fresh.archiveSha256, 'Published asset digest differs');
    }
    const assetUrl = `https://github.com/${REPOSITORY}/releases/download/${fresh.tag}/${fresh.assetName}`;
    assert.equal(asset.browser_download_url, assetUrl, 'Published asset URL differs from expected repository and identity');
    const catalog = { schemaVersion: 1, kind: 'forma-grand-prix-evidence-archive', publishedAt: new Date().toISOString(),
      observedAt: fresh.observedAt, suite: fresh.suite, status: fresh.status, quality: fresh.quality,
      ...(fresh.performanceAcceptance !== undefined ? { performanceAcceptance: fresh.performanceAcceptance } : {}),
      remote: { repository: REPOSITORY, runId: fresh.runId, attempt: fresh.attempt, artifactId: fresh.artifactId, artifactName: fresh.artifactName,
        workflow: fresh.workflow, conclusion: fresh.workflowConclusion, url: fresh.workflowUrl },
      source: { laboratoryCommit: fresh.sourceCommit, formaCommits: fresh.formaSourceCommits, originalManifestSha256: fresh.originalManifestSha256, originalSealSha256: fresh.originalSealSha256 },
      archive: { sha256: fresh.archiveSha256, bytes: fresh.archiveBytes, format: 'original-github-actions-zip' },
      release: { id: state.release.id, tag: fresh.tag, url: `https://github.com/${REPOSITORY}/releases/tag/${fresh.tag}`,
        target: state.release.target }, asset: { id: asset.id, name: fresh.assetName, url: assetUrl },
      note: 'Preserves the original attempt, including failures and diagnostic limits. Publication is not a new measurement or an endorsement of an improvement.' };
    const catalogFile = safePath(root, fresh.catalogPath);
    if (fs.existsSync(catalogFile)) {
      const previous = readJSON(catalogFile);
      assert.deepEqual(previous.archive, catalog.archive, 'Immutable catalog archive differs');
      assert.deepEqual(previous.remote, catalog.remote, 'Immutable catalog remote identity differs');
      assert.deepEqual(previous.source, catalog.source, 'Immutable catalog source differs');
      assert.deepEqual(previous.asset, catalog.asset, 'Immutable catalog asset differs');
      for (const field of ['observedAt', 'suite', 'status', 'quality', 'performanceAcceptance']) assert.deepEqual(previous[field], catalog[field], 'Immutable catalog observation differs: ' + field);
      return { published: true, reused: true, catalog: fresh.catalogPath, assetUrl, archiveSha256: fresh.archiveSha256 };
    }
    writeJSON(catalogFile, catalog, true);
    return { published: true, reused: Boolean(fresh.existingAsset), catalog: fresh.catalogPath, assetUrl, archiveSha256: fresh.archiveSha256 };
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); releaseLock(); }
}
