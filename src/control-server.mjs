import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { ROOT, config, history, readJSON, runPath, safePath, writeJSON } from './session.mjs';
import { createGitHub, dispatchPlan, REPOSITORY, WORKFLOWS, runCommand } from './github.mjs';

const MAX_BODY = 32 * 1024;
function json(response, status, data) { const body = JSON.stringify(data); response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(body); }
async function bodyJSON(request) {
  if (!(request.headers['content-type'] || '').startsWith('application/json')) throw Error('Use a JSON request body');
  let text = ''; for await (const chunk of request) { text += chunk; if (Buffer.byteLength(text) > MAX_BODY) throw Error('Request body is too large'); }
  const value = JSON.parse(text || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected a JSON object'); return value;
}
export async function controlDoctor(root, command = runCommand) {
  const checks = [{ name: 'Node.js', ok: Number(process.versions.node.split('.')[0]) >= 22, detail: process.version }];
  for (const [name, program, args] of [['GitHub CLI', 'gh', ['--version']], ['Python archive verifier', 'python3', ['--version']]]) {
    try { const result = await command(program, args, { cwd: root, timeout: 10000, maxBytes: 16384 }); checks.push({ name, ok: true, detail: result.stdout.trim() }); }
    catch (error) { checks.push({ name, ok: false, detail: error.message }); }
  }
  const disk = fs.statfsSync(root), free = disk.bavail * disk.bsize;
  checks.push({ name: 'Free disk space', ok: free >= 1024 ** 3, detail: (free / 1024 ** 3).toFixed(1) + ' GiB free; at least 1 GiB recommended for evidence import' });
  for (const file of ['config/laboratory.json', 'config/change-ledger.json']) { try { readJSON(safePath(root,file)); checks.push({ name: file, ok: true, detail: 'Readable' }); } catch(error) { checks.push({ name: file, ok: false, detail: error.message }); } }
  checks.push({ name: 'Local signals dependencies (optional)', ok: fs.existsSync(path.join(root,'signals-race/node_modules/@getforma/core/package.json')), optional: true, detail: 'Only needed for the local diagnostic. Install explicitly: npm ci --prefix signals-race --ignore-scripts' });
  return { ok: checks.every(check => check.ok || check.optional), checks, note: 'Hosted measurements run on Linux in GitHub Actions; Docker and Linux are not required to use this local control desk.' };
}
// Validate only the public catalog envelope here. Publication and downloaded
// archive authentication remain the responsibility of the archive/import tools.
export function readControlCatalog(root) {
  const catalog = [], catalogErrors = [];
  let directory, names;
  try {
    directory = safePath(root, 'evidence/catalog');
    if (!fs.existsSync(directory)) return { catalog, catalogErrors };
    names = fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort();
  } catch (error) { return { catalog, catalogErrors: [{ path: 'evidence/catalog', error: error.message }] }; }
  for (const name of names) {
    try {
      const file = safePath(directory, name), stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 128 * 1024) throw Error('Catalog record must be a regular JSON file no larger than 128 KiB');
      const record = readJSON(file), require = (valid, message) => { if (!valid) throw Error(message); };
      const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
      const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
      const id = value => (typeof value === 'string' || Number.isSafeInteger(value)) && /^[1-9]\d{0,19}$/.test(String(value));
      const sha = (value, length) => typeof value === 'string' && new RegExp('^[a-f0-9]{' + length + '}$').test(value);
      require(object(record) && record.schemaVersion === 1 && record.kind === 'forma-grand-prix-evidence-archive', 'Unsupported catalog schema');
      require(Object.hasOwn(WORKFLOWS, record.suite) && text(record.status) && text(record.quality), 'Invalid catalog suite or outcome');
      require(typeof record.observedAt === 'string' && Number.isFinite(Date.parse(record.observedAt)), 'Invalid observation timestamp');
      const { remote, archive, asset, release, source } = record;
      require(object(remote) && remote.repository === REPOSITORY && id(remote.runId) && id(remote.artifactId) && id(remote.attempt), 'Invalid catalog remote identity');
      require(name === `${remote.runId}-${remote.attempt}-${remote.artifactId}.json`, 'Catalog filename differs from its remote identity');
      require([`https://github.com/${REPOSITORY}/actions/runs/${remote.runId}`, `https://github.com/${REPOSITORY}/actions/runs/${remote.runId}/attempts/${remote.attempt}`].includes(remote.url), 'Invalid catalog workflow URL');
      require(object(archive) && sha(archive.sha256, 64) && Number.isSafeInteger(archive.bytes) && archive.bytes > 0 && archive.format === 'original-github-actions-zip', 'Invalid archive hash, size or format');
      require(object(source) && sha(source.laboratoryCommit, 40) && Array.isArray(source.formaCommits) && source.formaCommits.every(commit => sha(commit, 40)) && sha(source.originalManifestSha256, 64) && sha(source.originalSealSha256, 64), 'Invalid catalog source identity');
      require(object(release) && id(release.id) && typeof release.tag === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(release.tag), 'Invalid catalog release identity');
      require(release.url === `https://github.com/${REPOSITORY}/releases/tag/${release.tag}`, 'Invalid catalog release URL');
      require(object(asset) && id(asset.id) && typeof asset.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}\.zip$/.test(asset.name), 'Invalid catalog asset identity');
      require(asset.url === `https://github.com/${REPOSITORY}/releases/download/${release.tag}/${asset.name}`, 'Invalid catalog asset URL');
      catalog.push(record);
    } catch (error) { catalogErrors.push({ path: 'evidence/catalog/' + name, error: error.message }); }
  }
  catalog.sort((a,b) => b.observedAt.localeCompare(a.observedAt));
  return { catalog, catalogErrors };
}
function followedIdentity(run, input, bound) {
  if (String(run.id) !== String(input.runId) || run.repository !== REPOSITORY || run.url !== `https://github.com/${REPOSITORY}/actions/runs/${input.runId}`) throw Error('Followed run repository or identity differs');
  if (run.attempt !== input.attempt) throw Error(`Followed attempt changed from ${input.attempt} to ${run.attempt}; the new attempt was not selected.`);
  if (!Object.values(WORKFLOWS).some(workflow => run.workflow === '.github/workflows/' + workflow.file)) throw Error('Only registered Grand Prix workflows can be followed');
  if (!/^[a-f0-9]{40}$/.test(run.headSha || '')) throw Error('Followed run requires an exact laboratory source commit');
  if (!['queued','requested','waiting','pending','in_progress','completed'].includes(run.status)) throw Error('Unknown followed workflow status');
  if (bound && (run.workflow !== bound.workflow || run.headSha !== bound.headSha)) throw Error('Followed workflow or laboratory source changed');
  return { repository: run.repository, workflow: run.workflow, headSha: run.headSha, url: run.url };
}
function taskView(task) { return { ...task }; }
export async function startControlServer({ root = ROOT, port = 4317, github = createGitHub(root), command = runCommand, open = false } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid local port');
  const csrf = randomBytes(32).toString('hex'), tasksDir = safePath(root, '.grandprix/control-tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const tasks = new Map();
  for (const name of fs.readdirSync(tasksDir).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
    try { const task = readJSON(safePath(root, '.grandprix/control-tasks/' + name));
      if (['queued','running'].includes(task.status)) { task.status = 'interrupted'; task.error = 'The local control server stopped before this operation finished. No automatic replay.'; task.finishedAt = new Date().toISOString(); writeJSON(path.join(tasksDir, name), task); }
      tasks.set(task.id, task);
    } catch {}
  }
  let running = false, closing = false, remote = { runs: [], refreshedAt: null, error: null }, remotePromise;
  let account = { connected: false, loading: true, repository: REPOSITORY };
  const save = task => writeJSON(path.join(tasksDir, task.id + '.json'), task);
  const queue = [];
  const progress = (task, text) => { task.messages = [...(task.messages || []), { at: new Date().toISOString(), text: String(text).slice(0, 4000) }].slice(-80); save(task); };
  async function pump() {
    if (running || !queue.length || closing) return;
    running = true; const { task, action } = queue.shift(); task.status = 'running'; task.startedAt = new Date().toISOString(); save(task);
    try { task.result = await action(text => progress(task, text)); task.status = 'completed'; }
    catch (error) { task.status = 'failed'; task.error = error.message; }
    finally { task.finishedAt = new Date().toISOString(); save(task); running = false; void pump(); }
  }
  function enqueue(kind, input, action) {
    if (queue.length >= 8 || closing) throw Error('The control queue is full or closing');
    const task = { id: randomUUID(), kind, input, status: 'queued', createdAt: new Date().toISOString(), messages: [] };
    tasks.set(task.id, task); save(task); queue.push({ task, action }); void pump(); return taskView(task);
  }
  function ensureIdle() { if (fs.existsSync(safePath(root, '.grandprix/active.json'))) throw Error('A run or interrupted operation owns the laboratory. Inspect its history before starting another operation.'); }
  function scheduleImport(runId, attempt) {
    const existing = [...tasks.values()].find(task => task.kind === 'import' && String(task.input.runId) === String(runId) && String(task.input.attempt) === String(attempt) && ['queued','running','completed'].includes(task.status));
    if (existing) return taskView(existing);
    return enqueue('import', { runId, attempt }, async progress => { ensureIdle(); return github.importRun(runId, progress, attempt); });
  }
  async function followRun(input) {
    if (Object.keys(input).some(key => !['runId','attempt'].includes(key)) || !/^[1-9]\d{0,19}$/.test(String(input.runId)) || !Number.isSafeInteger(input.attempt) || input.attempt < 1) throw Error('Select an exact GitHub run and attempt');
    const selected = { runId: String(input.runId), attempt: input.attempt };
    const detail = await github.detail(selected.runId), identity = followedIdentity(detail, selected);
    const existing = [...tasks.values()].find(task => task.kind === 'follow' && task.input.runId === selected.runId && task.input.attempt === selected.attempt && ['watching','completed'].includes(task.status));
    if (existing) return taskView(existing);
    if (closing || [...tasks.values()].filter(task => task.kind === 'follow' && task.status === 'watching').length >= 8) throw Error('At most eight hosted attempts can be followed at once');
    const task = { id: randomUUID(), kind: 'follow', input: selected, result: identity, status: 'watching', createdAt: new Date().toISOString(), remoteStatus: detail.status, messages: [] };
    tasks.set(task.id, task); progress(task, `Following run ${selected.runId}, attempt ${selected.attempt}. Import begins only after that exact attempt completes. The local server must remain running or be restarted to resume following.`);
    return taskView(task);
  }
  async function refreshFollow(task) {
    if (task.importScheduled) {
      const imported = tasks.get(task.importScheduled);
      if (imported?.status === 'completed') { task.status = 'completed'; task.finishedAt = new Date().toISOString(); task.result = { ...task.result, ...imported.result }; delete task.error; save(task); }
      else if (!imported || ['failed','interrupted'].includes(imported.status)) { task.status = 'failed'; task.finishedAt = new Date().toISOString(); task.error = imported?.error || 'The evidence import was interrupted. Follow again or import explicitly to retry.'; save(task); }
      return;
    }
    let detail;
    try { detail = await github.detail(task.input.runId); }
    catch (error) { task.error = 'Remote check will retry: ' + error.message; task.checkedAt = new Date().toISOString(); save(task); return; }
    try { followedIdentity(detail, task.input, task.result); }
    catch (error) { task.status = 'failed'; task.error = error.message; task.finishedAt = new Date().toISOString(); save(task); return; }
    task.remoteStatus = detail.status; task.remoteConclusion = detail.conclusion; task.checkedAt = new Date().toISOString(); delete task.error;
    if (detail.status === 'completed') {
      try { ensureIdle(); const imported = scheduleImport(task.input.runId, task.input.attempt); task.importScheduled = imported.id; }
      catch (error) { task.error = 'Evidence import will wait: ' + error.message; }
    }
    save(task);
  }
  async function refreshRemote(force = false) {
    if (remotePromise) return remotePromise;
    if (!force && remote.refreshedAt && Date.now() - Date.parse(remote.refreshedAt) < 15_000) return remote;
    if ([...tasks.values()].some(task => task.kind === 'diagnostic' && task.status === 'running')) return { ...remote, deferred: 'Remote refresh pauses during local measurement.' };
    remotePromise = (async () => {
      try {
        if (force) account = await github.account();
        const runs = await github.runs(); remote = { runs, refreshedAt: new Date().toISOString(), error: null };
        for (const task of tasks.values()) if (task.kind === 'dispatch' && task.status === 'completed' && task.result?.autoImport && !task.importScheduled) {
          const run = runs.find(run => run.title?.includes(task.result.requestId) || task.result.runUrl?.endsWith('/' + run.id));
          if (run) { task.remoteRunId = run.id; task.remoteStatus = run.status; save(task); }
          if (run?.status === 'completed') { const imported = scheduleImport(run.id, run.attempt); task.importScheduled = imported.id; save(task); }
        }
        for (const task of [...tasks.values()]) if (task.kind === 'follow' && task.status === 'watching') await refreshFollow(task);
      } catch (error) { remote = { ...remote, error: error.message, refreshedAt: new Date().toISOString() }; }
      return remote;
    })().finally(() => { remotePromise = undefined; }); return remotePromise;
  }
  const accountPromise = github.account().then(value => { account = value; }).catch(error => { account = { connected: false, error: error.message, repository: REPOSITORY }; });
  let address;
  const server = http.createServer(async (request, response) => {
    try {
      const host = request.headers.host, allowedHosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`];
      if (!allowedHosts.includes(host) || ['cross-site','same-site'].includes(request.headers['sec-fetch-site'])) { json(response, 403, { error: 'This control desk accepts requests only from its own local page.' }); return; }
      const url = new URL(request.url, `http://${host}`);
      if (request.method === 'POST') {
        const token = request.headers['x-grandprix-csrf'];
        if (request.headers.origin !== `http://${host}` || typeof token !== 'string' || token.length !== csrf.length || !timingSafeEqual(Buffer.from(token), Buffer.from(csrf))) { json(response, 403, { error: 'Reload the local control page before making changes.' }); return; }
      } else if (request.method !== 'GET' && request.method !== 'HEAD') { json(response, 405, { error: 'Method not supported' }); return; }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        const { catalog, catalogErrors } = readControlCatalog(root);
        const records = history(root).map(m => ({ id: m.id, status: m.status, quality: m.quality, originalStatus: m.originalStatus || m.remote?.originalManifest?.status, originalQuality: m.originalQuality || m.remote?.originalManifest?.quality, suite: m.config?.suite || m.plan?.suite || 'archive', startedAt: m.observedAt || m.startedAt,
          importedAt: m.importedAt, performanceAcceptance: m.remote?.originalManifest?.performanceAcceptance || m.performanceAcceptance || null, remote: m.remote ? { runId: m.remote.runId, url: m.remote.url, conclusion: m.remote.conclusion, attempt: m.remote.attempt } : null,
          report: `/runs/${encodeURIComponent(m.id)}/report.html`, source: m.source?.commit || m.plan?.formaRef || null, cleanup: m.cleanup }));
        json(response, 200, { csrf, config: config(root), workflows: WORKFLOWS, account, history: records, catalog, catalogErrors, active: fs.existsSync(safePath(root, '.grandprix/active.json')) ? readJSON(safePath(root, '.grandprix/active.json')) : null,
          tasks: [...tasks.values()].sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 40).map(taskView), remote, localUrl: `http://127.0.0.1:${address.port}` }); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/ledger') { json(response, 200, readJSON(path.join(root, 'config/change-ledger.json'))); return; }
      if (request.method === 'GET' && url.pathname === '/api/remote') { json(response, 200, await refreshRemote(url.searchParams.get('refresh') === '1')); return; }
      const remoteMatch = url.pathname.match(/^\/api\/remote\/(\d+)$/);
      if (request.method === 'GET' && remoteMatch) { json(response, 200, await github.detail(remoteMatch[1])); return; }
      const taskMatch = url.pathname.match(/^\/api\/tasks\/([a-f0-9-]{36})$/);
      if (request.method === 'GET' && taskMatch) { const task = tasks.get(taskMatch[1]); json(response, task ? 200 : 404, task ? taskView(task) : { error: 'Task not found' }); return; }
      if (request.method === 'POST' && url.pathname === '/api/dispatch') {
        const input = await bodyJSON(request); ensureIdle(); dispatchPlan(root,input);
        const task = enqueue('dispatch', input, progress => { progress('Submitting the selected test plan to GitHub Actions.'); return github.dispatch(input); });
        json(response, 202, task); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/follow') { const input = await bodyJSON(request); ensureIdle(); json(response, 202, await followRun(input)); return; }
      if (request.method === 'POST' && url.pathname === '/api/restore') {
        const input = await bodyJSON(request); ensureIdle();
        if (Object.keys(input).some(key => key !== 'catalog') || typeof input.catalog !== 'string' || !/^evidence\/catalog\/[1-9]\d*-[1-9]\d*-[1-9]\d*\.json$/.test(input.catalog)) throw Error('Select a versioned evidence catalog record');
        json(response, 202, enqueue('restore', input, async progress => {
          ensureIdle(); progress('Restoring the exact original release archive and verifying its source, outcome and integrity.');
          const {restoreArchive}=await import('./archive-restore.mjs');
          return restoreArchive(root,input.catalog,{command,onProgress:progress});
        })); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/import') { const input = await bodyJSON(request); if (!/^\d+$/.test(String(input.runId))) throw Error('Select a GitHub run'); if (!Number.isInteger(input.attempt) || input.attempt < 1) throw Error('Select a run attempt'); json(response, 202, scheduleImport(input.runId, input.attempt)); return; }
      if (request.method === 'POST' && url.pathname === '/api/local') {
        const input = await bodyJSON(request); ensureIdle();
        const actions = ['verify','report','doctor','diagnostic']; if (!actions.includes(input.action)) throw Error('Unknown local action');
        let args;
        if (['verify','report'].includes(input.action)) { runPath(root, input.id); args = [input.action, input.id]; }
        else if (input.action === 'doctor') { json(response, 202, enqueue('doctor', input, async () => { const result = await controlDoctor(root, command); return { output: JSON.stringify(result, null, 2), ok: result.ok }; })); return; }
        else {
          if (input.confirmDiagnostic !== true) throw Error('Explicitly confirm local diagnostic measurement');
          if (!fs.existsSync(path.join(root,'signals-race/node_modules/@getforma/core/package.json'))) throw Error('Local diagnostic dependencies are missing. Install explicitly: npm ci --prefix signals-race --ignore-scripts');
          args = ['run','--suite','signals','--mode','diagnostic','--cars','forma,alien-signals','--id','local-ui-' + randomUUID()];
        }
        json(response, 202, enqueue(input.action, input, async progress => { ensureIdle(); progress(input.action === 'diagnostic' ? 'Local diagnostic only. Remote refresh is paused until it finishes.' : 'Checking retained local evidence.');
          const result = await command(process.execPath, [path.join(root, 'src/cli.mjs'), ...args], { cwd: root, timeout: input.action === 'diagnostic' ? 300_000 : 90_000, maxBytes: 512 * 1024, onProgress: progress, beforeForceKill: pid => {
            const lockFile = safePath(root, '.grandprix/active.json'); if (!fs.existsSync(lockFile)) return; const lock = readJSON(lockFile);
            if (lock.pid === pid && lock.hostname === os.hostname() && lock.operation === 'run' && Number.isInteger(lock.workerProcessGroup) && lock.workerProcessGroup > 1 && process.platform !== 'win32') { try { process.kill(-lock.workerProcessGroup, 'SIGKILL'); } catch(error) { if(error.code !== 'ESRCH') throw error; } }
          } });
          return { output: result.stdout.slice(-64 * 1024), report: input.id ? `/runs/${encodeURIComponent(input.id)}/report.html` : null }; })); return;
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        let file, type, download = false, report = false;
        if (['/','/index.html','/app.js','/styles.css'].includes(url.pathname)) {
          file = path.join(root, 'web', url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
          type = url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'text/html';
        } else if (/^\/(runs|docs|evidence|provenance)\//.test(url.pathname)) {
          const relative = decodeURIComponent(url.pathname.slice(1));
          if (relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Noncanonical evidence path');
          file = safePath(root, relative);
          const ext = path.extname(file); report = /^runs\/[^/]+\/report\.html$/.test(relative);
          if (!report && !['.json','.csv','.md','.log','.txt','.zip'].includes(ext)) throw Error('This evidence file is not exposed by the control desk');
          type = report ? 'text/html' : ext === '.json' ? 'application/json' : ext === '.zip' ? 'application/zip' : 'text/plain'; download = ['.zip','.csv'].includes(ext);
        }
        if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
          const stat = fs.statSync(file); const headers = { 'Content-Type': type + (type.startsWith('text/') || type === 'application/json' ? '; charset=utf-8' : ''), 'Content-Length': stat.size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': report ? "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; sandbox allow-scripts" : "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" };
          if (download) headers['Content-Disposition'] = `attachment; filename="${path.basename(file).replace(/[^a-zA-Z0-9._-]/g, '_')}"`;
          response.writeHead(200, headers); if (request.method === 'HEAD') response.end(); else { const stream = fs.createReadStream(file); stream.on('error', () => response.destroy()); stream.pipe(response); } return;
        }
      }
      json(response, 404, { error: 'Not found' });
    } catch (error) { if (!response.headersSent) json(response, 400, { error: error.message }); else response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  address = server.address(); const url = `http://127.0.0.1:${address.port}`;
  // Read-only remote refresh. Measurement and dispatch always require an explicit action.
  const timer = setInterval(() => { if (!closing && account.connected) void refreshRemote(); }, 20_000); timer.unref();
  if (open) console.log(`Open ${url} in your browser.`);
  return { server, url, port: address.port, accountReady: accountPromise, close: async () => { closing = true; clearInterval(timer); await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }); }, refreshRemote };
}
