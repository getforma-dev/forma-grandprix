// CI adapter: one immutable source selection and retained attempt per hosted job.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT, acquire, config, environment, readJSON, runPath, seal, sourceIdentity, writeJSON } from './session.mjs';
import { generateReport } from './report.mjs';
import { planCleanup, applyCleanup } from './cleanup.mjs';

export const SUITES = ['server', 'client', 'islands', 'paired', 'compression'];
const exact = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export function driverPlan(root, suite, env = process.env) {
  if (!SUITES.includes(suite)) throw Error('Unknown CI suite');
  const profile = env.GP_PROFILE || 'gha-4-v1';
  if (!['gha-4-v1', 'native-8-v1'].includes(profile)) throw Error('Unknown resource profile');
  if (!['true', 'false'].includes(env.GP_DIAGNOSTIC ?? 'false')) throw Error('GP_DIAGNOSTIC must be true or false');
  const diagnostic = env.GP_DIAGNOSTIC === 'true';
  const refs = (['paired', 'client'].includes(suite) ? env.GP_FORMA_REFS || env.GP_CLIENT_REFS || '' : env.GP_FORMA_REF || '').split(',').filter(Boolean);
  if (refs.some(ref => !exact(ref)) || new Set(refs).size !== refs.length || refs.length > 4) throw Error('Forma selections must be one to four unique exact commits');
  if (['paired', 'compression'].includes(suite) && !refs.length) throw Error('This comparison requires an exact Forma source commit');
  if (['server', 'compression'].includes(suite) && refs.length > 1) throw Error('Server input takes one exact Forma source commit');
  const runtimeEnv = { GP_PROFILE: profile, GP_DIAGNOSTIC: String(diagnostic) };
  const args = [];
  if (['server', 'compression'].includes(suite)) {
    args.push('harness/ci-run.mjs');
    Object.assign(runtimeEnv, { GP_CARS: suite === 'compression' ? 'forma' : env.GP_CARS || 'forma', GP_EVENTS: suite === 'compression' ? '1,3,4,5,7' : env.GP_EVENTS || '1,5-7',
      GP_FORMA_REF: refs[0] || '', GP_BASELINE: 'true', GP_COMPRESSION: String(suite === 'compression'), GP_CHECK_BUDGETS: String(suite !== 'compression') });
  } else if (suite === 'paired') {
    args.push('harness/paired-server.mjs'); runtimeEnv.GP_FORMA_REFS = refs.join(',');
  } else {
    const chrome = env.CHROME_PATH || env.GP_CHROME;
    if (!chrome || !path.isAbsolute(chrome)) throw Error('The authenticated browser path is required');
    if (suite === 'client') {
      const browser = readJSON(path.join(root, 'harness/chromium-linux-lock.json'));
      args.push('harness/client-linux.mjs', '--chrome', chrome, '--chrome-sha256', browser.executableSha256, '--forma-refs', refs.join(','));
      if (env.GP_PROFILE_ROWS === 'true') args.push('--profile-rows');
      if (env.GP_COMPILER_TEMPLATES === 'true') args.push('--compiler-templates');
    } else args.push('harness/islands-linux.mjs', '--chrome', chrome, '--cars', env.GP_CARS || config(root).suites.islands.cars.join(','));
    if (diagnostic) args.push('--diagnostic');
  }
  return { suite, profile, diagnostic, formaRefs: refs, args, env: runtimeEnv };
}
export function beginAttempt(root, suite, env = process.env) {
  if (!SUITES.includes(suite)) throw Error('Unknown CI suite');
  const id = env.GP_RUN_ID, dir = runPath(root, id);
  if (fs.existsSync(dir)) throw Error('Run ID already exists; a prior attempt cannot be replaced');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(path.join(dir, 'artifacts'));
  const source = sourceIdentity(root), refs = (env.GP_FORMA_REFS || env.GP_CLIENT_REFS || env.GP_FORMA_REF || '').split(',').filter(Boolean);
  const manifest = { schemaVersion: 1, id, protocolVersion: config(root).protocolVersion, testHash: source.testHash,
    status: 'preparing', quality: 'unqualified', mode: env.GP_DIAGNOSTIC === 'true' ? 'diagnostic' : 'qualified', startedAt: new Date().toISOString(),
    source, labSourceCommit: source.commit, formaSourceCommits: refs, environment: environment(),
    config: { suite, profile: env.GP_PROFILE || 'gha-4-v1', cars: env.GP_CARS || null, events: env.GP_EVENTS || null,
      compilerTemplates: env.GP_COMPILER_TEMPLATES === 'true', profileRows: env.GP_PROFILE_ROWS === 'true' },
    remote: { provider: 'github-actions', repository: env.GITHUB_REPOSITORY || null, runId: env.GITHUB_RUN_ID || null,
      runAttempt: env.GITHUB_RUN_ATTEMPT || null, job: env.GITHUB_JOB || null, requestId: env.GP_REQUEST_ID || null,
      url: env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null },
    note: 'Hosted attempt. Qualification is derived from original driver evidence, not job success alone.' };
  writeJSON(path.join(dir, 'manifest.json'), manifest, true);
  return manifest;
}
export async function captureAttempt(root, suite, env = process.env) {
  const dir = runPath(root, env.GP_RUN_ID), file = path.join(dir, 'manifest.json');
  const manifest = readJSON(file);
  if (manifest.status !== 'preparing' || manifest.config.suite !== suite) throw Error('Attempt is not a fresh prepared suite');
  const release = acquire(root, env.GP_RUN_ID), logFile = path.join(dir, 'run.log');
  let fd, code = 1;
  try {
    const plan = driverPlan(root, suite, env);
    manifest.status = 'running'; manifest.plan = plan; writeJSON(file, manifest);
    fd = fs.openSync(logFile, 'wx');
    const childEnv = { ...env, ...plan.env, GP_RESULTS_DIR: path.join(dir, 'artifacts') };
    for (const key of ['GP_RAW_DIR', 'GP_OUT', 'GP_CAMPAIGN_FILE', 'GP_CAMPAIGN_JSON', 'GP_RESOURCE_PROFILE', 'GP_IMAGE_PREFIX', 'GP_ACCEPT_ENCODING']) delete childEnv[key];
    code = await new Promise((resolve, reject) => {
      release.update({ phase: 'starting-worker' });
      const child = spawn(process.execPath, plan.args, { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      if (child.pid) release.update({ phase: 'running', workerPid: child.pid, ...(process.platform !== 'win32' ? { workerProcessGroup: child.pid } : {}) });
      const signal = name => { manifest.interrupted = true; try { if (process.platform !== 'win32') process.kill(-child.pid, name); else child.kill(name); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
      const stop = () => signal('SIGTERM'), interrupt = () => signal('SIGINT');
      process.once('SIGTERM', stop); process.once('SIGINT', interrupt);
      const clear = () => { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', interrupt); release.update({ phase: 'finishing' }); };
      for (const [pipe, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) pipe.on('data', data => { fs.writeSync(fd, data); output.write(data); });
      child.once('error', error => { clear(); reject(error); });
      child.once('close', status => { clear(); resolve(status ?? 1); });
    });
    manifest.exitCode = code; manifest.status = manifest.interrupted ? 'interrupted' : code === 0 ? 'completed' : 'failed';
    manifest.sourceAfter = sourceIdentity(root).sourceHash;
    if (manifest.sourceAfter !== manifest.source.sourceHash) { manifest.status = 'invalid'; manifest.error = 'Laboratory inputs changed during execution'; code = 1; }
  } catch (error) { manifest.status = 'failed'; manifest.error = error.message; code = 1; }
  finally { if (fd !== undefined) fs.closeSync(fd); manifest.finishedAt = new Date().toISOString(); writeJSON(file, manifest); release(); }
  return code;
}
export async function finishAttempt(root, suite, env = process.env) {
  const dir = runPath(root, env.GP_RUN_ID), file = path.join(dir, 'manifest.json');
  let manifest;
  if (!fs.existsSync(file)) manifest = beginAttempt(root, suite, env);
  else manifest = readJSON(file);
  if (manifest.config.suite !== suite) throw Error('Finalization suite differs');
  if (['preparing', 'running'].includes(manifest.status)) { manifest.status = 'failed'; manifest.error = 'Preparation or execution did not complete; inspect the linked Actions job logs.'; }
  if (['failure', 'cancelled'].includes(env.GP_WORKFLOW_STATUS) && manifest.status === 'completed') {
    manifest.status = 'failed'; manifest.error = 'A setup, benchmark or cleanup job step failed; retain measurements for diagnosis only.';
  }
  manifest.finishedAt ||= new Date().toISOString();
  writeJSON(file, manifest);
  try {
    const plan = await planCleanup(root, { runId: manifest.id, includeDependencies: true });
    if (plan.blocked.length) throw Error(plan.blocked.join(' '));
    const cleanup = await applyCleanup(root, plan); manifest.cleanup = { completed: cleanup.completed, receipt: path.relative(dir, cleanup.receiptPath), plannedBytes: cleanup.plannedBytes };
  } catch (error) { manifest.cleanup = { completed: false, error: error.message }; if (manifest.status === 'completed') manifest.status = 'failed'; }
  writeJSON(file, manifest);
  let report;
  try { report = generateReport(dir); }
  catch (error) {
    manifest.reportError = error.message; manifest.status = 'failed';
    fs.writeFileSync(path.join(dir, 'report.md'), `# Forma Grand Prix — retained failed attempt\n\nReport generation failed: ${error.message}\n\nRaw evidence and the manifest remain available.\n`);
    fs.writeFileSync(path.join(dir, 'report.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><title>Forma Grand Prix — retained failure</title><h1>Retained failed attempt</h1><p>The report could not be generated. Inspect manifest.json and raw artifacts.</p></html>');
  }
  manifest.quality = manifest.mode === 'diagnostic' ? 'diagnostic' : manifest.status === 'completed' && report?.measurements.length && report.measurements.every(m => m.qualification === 'qualified' && (m.status === 'measured' || (m.status === 'unavailable' && m.required === false))) ? 'qualified' : 'unqualified';
  manifest.workflowStatus = env.GP_WORKFLOW_STATUS || null; writeJSON(file, manifest);
  if (!manifest.reportError) generateReport(dir);
  seal(dir);
  return { id: manifest.id, status: manifest.status, quality: manifest.quality, directory: dir };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [operation, suite] = process.argv.slice(2);
    if (operation === 'begin') console.log(JSON.stringify(beginAttempt(ROOT, suite)));
    else if (operation === 'run') process.exitCode = await captureAttempt(ROOT, suite);
    else if (operation === 'finish') console.log(JSON.stringify(await finishAttempt(ROOT, suite)));
    else throw Error('Usage: node src/ci-capture.mjs begin|run|finish server|client|islands|paired|compression');
  } catch (error) { console.error('Grand Prix CI: ' + error.message); process.exitCode = 1; }
}
