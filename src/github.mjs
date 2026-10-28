import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { acquire, config, hash, readJSON, runPath, safePath, seal, verify, writeJSON } from './session.mjs';
import { generateReport } from './report.mjs';

export const REPOSITORY = 'getforma-dev/forma-grandprix';
export const WORKFLOWS = {
  server: { file: 'grand-prix.yml', title: 'Server rendering', description: 'Rendering, latency, memory, startup and build cost.', selections: true },
  client: { file: 'grand-prix-client.yml', title: 'Browser + signals', description: 'Keyed DOM work, shipped JavaScript and reactive behavior. Complete controlled grid.' },
  islands: { file: 'grand-prix-islands.yml', title: 'Island activation', description: 'Server HTML adoption, activation and verified browser interaction.', selections: true },
  paired: { file: 'grand-prix-paired.yml', title: 'Paired source comparison', description: 'Published Forma control and exact candidates on the same runner.' },
  compression: { file: 'grand-prix-compression.yml', title: 'Compression experiment', description: 'Identity, gzip and Brotli with retained wire and decoded-page evidence.' },
};
const numberId = value => { if (!/^[1-9]\d{0,19}$/.test(String(value))) throw Error('A numeric GitHub identity is required'); return String(value); };
export function runCommand(program, args, { cwd, input, timeout = 60_000, maxBytes = 8 * 1024 ** 2, outputFile, onProgress = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', bytes = 0, failure, fd;
    try { if (outputFile) fd = fs.openSync(outputFile, 'wx'); } catch (error) { reject(error); return; }
    const child = spawn(program, args, { cwd, env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const stop = reason => { failure ??= Error(reason); child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 1000).unref(); };
    const timer = setTimeout(() => stop('Operation exceeded its time limit'), timeout); timer.unref();
    child.stdout.on('data', data => {
      bytes += data.length;
      if (bytes > maxBytes) { stop('Operation exceeded its output limit'); return; }
      if (fd !== undefined) fs.writeSync(fd, data); else stdout += data.toString();
    });
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-64 * 1024); onProgress(data.toString().slice(-2000)); });
    child.once('error', error => { failure = error; });
    child.once('close', code => {
      clearTimeout(timer); if (fd !== undefined) fs.closeSync(fd);
      if (failure || code !== 0) reject(failure || Error(stderr.trim() || `${program} exited ${code}`));
      else resolve({ stdout, stderr, bytes });
    });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
const allowed = (object, keys) => { for (const key of Object.keys(object)) if (!keys.includes(key)) throw Error('Unknown request field: ' + key); };
const exactRefs = (value, fallback) => {
  const values = (value || fallback).split(',').map(value => value.trim());
  if (values.length < 1 || values.length > 4 || new Set(values).size !== values.length || values.some(value => !/^[a-f0-9]{40}$/.test(value))) throw Error('Supply one to four unique exact Forma source commits');
  return values.join(',');
};
export function dispatchPlan(root, input) {
  allowed(input, ['suite', 'cars', 'events', 'formaRef', 'formaRefs', 'profile', 'diagnostic', 'workflowRef', 'profileRows', 'compilerTemplates', 'autoImport']);
  const suite = input.suite, workflow = WORKFLOWS[suite]; if (!workflow) throw Error('Unknown remote test suite');
  const cfg = config(root), diagnostic = input.diagnostic ?? false;
  if (typeof diagnostic !== 'boolean' || (input.autoImport !== undefined && typeof input.autoImport !== 'boolean')) throw Error('Diagnostic/import settings must be booleans');
  const profile = input.profile || 'gha-4-v1'; if (!['gha-4-v1', 'native-8-v1'].includes(profile)) throw Error('Unknown resource profile');
  const workflowRef = input.workflowRef || 'main';
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(workflowRef) || workflowRef.includes('..') || workflowRef.includes('//') || workflowRef.endsWith('/')) throw Error('Invalid workflow branch or tag');
  const requestId = 'local-' + randomUUID();
  const fields = { runner: 'ubuntu-24.04', profile, diagnostic: String(diagnostic), request_id: requestId };
  // The dashboard only offers the standard hosted four-CPU allocation. A native
  // eight-CPU host needs an explicitly administered runner outside this interface.
  if (profile !== 'gha-4-v1') throw Error('This control desk uses the hosted four-CPU profile. Configure a native runner through GitHub Actions.');
  if (suite === 'server' || suite === 'islands') {
    const cars = input.cars ?? cfg.suites[suite].cars;
    if (!Array.isArray(cars) || !cars.length || new Set(cars).size !== cars.length || cars.some(car => !cfg.suites[suite].cars.includes(car))) throw Error('Choose registered competitors without duplicates');
    fields.cars = cars.join(',');
  } else if (input.cars !== undefined || input.events !== undefined) throw Error('This suite uses its complete fixed workload');
  if (suite === 'server') {
    const events = input.events ?? [1, 5, 6, 7];
    if (!Array.isArray(events) || !events.length || events.some(value => !Number.isInteger(value) || value < 1 || value > 8) || new Set(events).size !== events.length) throw Error('Choose server events 1–8 without duplicates');
    fields.events = [...events].sort().join(',');
  } else if (input.events !== undefined) throw Error('Event selection is supported by the server suite');
  if (suite === 'server' || suite === 'compression') {
    fields.forma_ref = exactRefs(input.formaRef, cfg.currentForma.sourceCommit);
    if (fields.forma_ref.includes(',')) throw Error('This suite takes one exact Forma source commit');
  } else if (suite === 'client' || suite === 'paired') fields.forma_refs = exactRefs(input.formaRefs, cfg.currentForma.sourceCommit);
  else if (input.formaRef || input.formaRefs) throw Error('Island recipes use their declared frozen dependencies; no candidate override is supported');
  if (suite === 'client') for (const [key, field] of [['profileRows','profile_rows'],['compilerTemplates','compiler_templates']]) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') throw Error('Client settings must be booleans'); fields[field] = String(input[key] ?? false);
  }
  return { suite, workflow: workflow.file, workflowRef, fields, requestId, repository: REPOSITORY, autoImport: input.autoImport !== false };
}
export function createGitHub(root, { command = runCommand } = {}) {
  const call = (args, options = {}) => command('gh', args, { cwd: root, ...options });
  const api = async endpoint => JSON.parse((await call(['api', endpoint])).stdout);
  return {
    async account() { try { const login = (await call(['api', 'user', '--jq', '.login'], { timeout: 15_000 })).stdout.trim(); return { connected: true, login, repository: REPOSITORY }; } catch (error) { return { connected: false, repository: REPOSITORY, error: error.message }; } },
    async runs() {
      const data = await api(`repos/${REPOSITORY}/actions/runs?event=workflow_dispatch&per_page=30`);
      return data.workflow_runs.filter(run => Object.values(WORKFLOWS).some(workflow => run.path === '.github/workflows/' + workflow.file)).map(run => ({
        id: run.id, attempt: run.run_attempt, name: run.name, title: run.display_title, status: run.status, conclusion: run.conclusion,
        url: run.html_url, headSha: run.head_sha, branch: run.head_branch, workflow: run.path, createdAt: run.created_at, updatedAt: run.updated_at,
      }));
    },
    async detail(id) {
      id = numberId(id); const [run, jobs] = await Promise.all([api(`repos/${REPOSITORY}/actions/runs/${id}`), api(`repos/${REPOSITORY}/actions/runs/${id}/jobs?per_page=50`)]);
      return { id: run.id, status: run.status, conclusion: run.conclusion, url: run.html_url, jobs: jobs.jobs.map(job => ({ name: job.name, status: job.status, conclusion: job.conclusion,
        steps: (job.steps || []).map(step => ({ name: step.name, status: step.status, conclusion: step.conclusion, number: step.number })) })) };
    },
    async dispatch(input) {
      const plan = dispatchPlan(root, input);
      const result = await call(['workflow', 'run', plan.workflow, '--repo', REPOSITORY, '--ref', plan.workflowRef, '--json'], { input: JSON.stringify(plan.fields), timeout: 30_000 });
      return { ...plan, dispatchedAt: new Date().toISOString(), message: result.stdout.trim(), runUrl: result.stdout.match(/https:\/\/github\.com\/getforma-dev\/forma-grandprix\/actions\/runs\/\d+/)?.[0] ?? null };
    },
    async artifacts(id) { id = numberId(id); const data = await api(`repos/${REPOSITORY}/actions/runs/${id}/artifacts?per_page=100`); return data.artifacts; },
    async importRun(id, onProgress = () => {}) {
      id = numberId(id); onProgress('Checking completed workflow and artifact ownership.');
      const run = await api(`repos/${REPOSITORY}/actions/runs/${id}`);
      if (run.status !== 'completed') throw Error('Wait until the workflow is completed before importing evidence');
      const suite = Object.entries(WORKFLOWS).find(([, value]) => run.path === '.github/workflows/' + value.file)?.[0];
      if (!suite) throw Error('This is not a registered Grand Prix workflow');
      const data = await api(`repos/${REPOSITORY}/actions/runs/${id}/artifacts?per_page=100`);
      const candidates = data.artifacts.filter(artifact => artifact.name === `grand-prix-${suite}-${id}-${run.run_attempt}` && !artifact.expired);
      if (candidates.length !== 1) throw Error('One unexpired evidence artifact is required; it may still be uploading or was not produced');
      const artifact = candidates[0]; numberId(artifact.id);
      if (!Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes <= 0 || artifact.size_in_bytes > 256 * 1024 ** 2) throw Error('Artifact exceeds the 256 MiB download limit');
      if (artifact.workflow_run?.id && String(artifact.workflow_run.id) !== id) throw Error('Artifact belongs to another workflow run');
      const localId = `github-${id}-${run.run_attempt}-${artifact.id}`, destination = runPath(root, localId);
      if (fs.existsSync(destination)) {
        const integrity = verify(destination); if (!integrity.ok) throw Error('Previously imported evidence changed; inspect its integrity report');
        return { id: localId, reused: true, remoteRunId: run.id, report: `/runs/${localId}/report.html` };
      }
      const release = acquire(root, localId, { operation: 'import' });
      const scratch = safePath(root, `.grandprix/downloads/${randomUUID()}`); fs.mkdirSync(scratch, { recursive: true });
      let manifest;
      try {
        const archive = path.join(scratch, 'artifact.zip');
        onProgress('Downloading the exact workflow artifact.');
        await call(['api', `repos/${REPOSITORY}/actions/artifacts/${artifact.id}/zip`], { outputFile: archive, maxBytes: 256 * 1024 ** 2, timeout: 180_000, onProgress });
        const digest = hash(fs.readFileSync(archive));
        if (artifact.digest && artifact.digest !== 'sha256:' + digest) throw Error('Downloaded archive differs from the GitHub artifact digest');
        fs.mkdirSync(destination); fs.copyFileSync(archive, path.join(destination, 'original.zip'), fs.constants.COPYFILE_EXCL);
        manifest = { schemaVersion: 1, id: localId, status: 'importing', mode: 'remote-evidence', quality: 'unverified-import', startedAt: run.created_at,
          importedAt: new Date().toISOString(), remote: { repository: REPOSITORY, runId: run.id, attempt: run.run_attempt, conclusion: run.conclusion, workflow: run.path, headSha: run.head_sha, url: run.html_url, artifactId: artifact.id, artifactName: artifact.name, archiveSha256: digest, advertisedDigest: artifact.digest || null },
          note: 'Imported GitHub evidence. This is not a new local measurement; original campaign and qualification remain in retained records.' };
        writeJSON(path.join(destination, 'manifest.json'), manifest, true);
        const extracted = path.join(destination, 'artifacts', 'remote'); fs.mkdirSync(extracted, { recursive: true });
        onProgress('Checking archive paths, size bounds and the original evidence seal.');
        await command('python3', ['-c', SAFE_EXTRACT, archive, extracted], { cwd: root, timeout: 60_000, maxBytes: 1024 ** 2 });
        const original = readJSON(safePath(extracted, 'manifest.json')), checked = verify(extracted);
        if (!checked.ok) throw Error('Remote evidence integrity failed: ' + checked.problems.slice(0, 5).join('; '));
        if (original.remote?.runId && String(original.remote.runId) !== id) throw Error('Remote manifest run identity differs');
        manifest.remote.originalManifest = original; manifest.remote.originalIntegrity = checked;
        for (const field of ['protocolVersion', 'testHash', 'config', 'environment', 'source', 'plan', 'expected']) if (original[field] !== undefined) manifest[field] = original[field];
        manifest.observedAt = original.startedAt || run.created_at; manifest.finishedAt = original.finishedAt || run.updated_at;
        manifest.status = 'imported'; manifest.quality = 'remote-import';
        writeJSON(path.join(destination, 'manifest.json'), manifest); generateReport(destination); seal(destination);
        onProgress('Evidence retained and readable reports refreshed.');
        return { id: localId, remoteRunId: run.id, originalStatus: original.status, originalQuality: original.quality, report: `/runs/${localId}/report.html` };
      } catch (error) {
        if (manifest) { manifest.status = 'failed'; manifest.error = error.message; manifest.finishedAt = new Date().toISOString(); writeJSON(path.join(destination, 'manifest.json'), manifest); try { generateReport(destination); seal(destination); } catch {} }
        throw error;
      } finally { fs.rmSync(scratch, { recursive: true, force: true }); release(); }
    },
  };
}
export const SAFE_EXTRACT = `import zipfile,pathlib,stat,sys
archive,out=sys.argv[1:];root=pathlib.Path(out).resolve()
with zipfile.ZipFile(archive) as z:
 infos=z.infolist();assert len(infos)<=20000 and sum(i.file_size for i in infos)<=512*1024*1024,'archive exceeds extraction limits'
 names=set()
 for i in infos:
  p=pathlib.PurePosixPath(i.filename);name=i.filename.rstrip('/')
  assert name and not p.is_absolute() and '..' not in p.parts and '\\\\' not in name and ':' not in name and '\\x00' not in name,'unsafe archive path'
  assert p.as_posix()==name and name not in names,'duplicate or noncanonical archive member';names.add(name)
  kind=stat.S_IFMT(i.external_attr>>16);assert kind in (0,stat.S_IFREG,stat.S_IFDIR),'special archive member'
  assert (root/str(p)).resolve().is_relative_to(root),'archive leaves destination'
 for i in infos:
  dest=root/i.filename
  if i.is_dir():dest.mkdir(parents=True,exist_ok=True)
  else:
   dest.parent.mkdir(parents=True,exist_ok=True)
   with dest.open('xb') as out:
    with z.open(i) as source:
     while True:
      part=source.read(1024*1024)
      if not part:break
      out.write(part)
print(len(infos))`;
