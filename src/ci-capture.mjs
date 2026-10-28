// CI adapter: one immutable source selection and retained attempt per hosted job.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ROOT, acquire, config, environment, hash, readJSON, runPath, safePath, seal, sourceIdentity, writeJSON } from './session.mjs';
import { generateReport } from './report.mjs';
import { planCleanup, applyCleanup } from './cleanup.mjs';
import { planRecovery, applyRecovery } from './recovery.mjs';
import { authenticatePhaseReceipt, BUDGET_FILES, PHASE_FILE } from '../harness/ci-run.mjs';
import { evaluateBudgets } from '../harness/budgets.mjs';
import { ensureFormaSource } from '../harness/forma-source.mjs';

export const SUITES = ['server', 'client', 'islands', 'paired', 'compression'];
const serverEvents = ['sprint', 'endurance', 'multicore', 'reaction', 'fuel', 'grid', 'weight', 'pitstop'];
export function eventSelection(text = '1-8') {
  const selected = new Set();
  for (const item of text.split(',')) {
    if (!/^[1-8](?:-[1-8])?$/.test(item)) throw Error('Server events must be numbers or ranges within 1–8');
    const [first, last = first] = item.split('-').map(Number);
    if (first > last) throw Error('Server event ranges must ascend');
    for (let event = first; event <= last; event++) selected.add(serverEvents[event - 1]);
  }
  return [...selected];
}
function selectedRefs(suite, env) {
  if (suite === 'islands' && [env.GP_FORMA_REFS, env.GP_CLIENT_REFS, env.GP_FORMA_REF].some(Boolean)) throw Error('Islands measures locked registry adapters; exact Forma source candidates are unsupported in this lane');
  const refs = (['paired', 'client'].includes(suite) ? env.GP_FORMA_REFS || env.GP_CLIENT_REFS || '' : env.GP_FORMA_REF || '').split(',').filter(Boolean);
  if (refs.some(ref => !exact(ref)) || new Set(refs).size !== refs.length || refs.length > 4) throw Error('Forma selections must be one to four unique exact commits');
  if (['paired', 'compression'].includes(suite) && !refs.length) throw Error('This comparison requires an exact Forma source commit');
  if (['server', 'compression'].includes(suite) && refs.length > 1) throw Error('Server input takes one exact Forma source commit');
  return refs;
}
const exact = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export function driverPlan(root, suite, env = process.env) {
  if (!SUITES.includes(suite)) throw Error('Unknown CI suite');
  const profile = env.GP_PROFILE || 'gha-4-v1';
  if (!['gha-4-v1', 'native-8-v1'].includes(profile)) throw Error('Unknown resource profile');
  if (!['true', 'false'].includes(env.GP_DIAGNOSTIC ?? 'false')) throw Error('GP_DIAGNOSTIC must be true or false');
  const diagnostic = env.GP_DIAGNOSTIC === 'true';
  const refs = selectedRefs(suite, env);
  const runtimeEnv = { GP_PROFILE: profile, GP_DIAGNOSTIC: String(diagnostic) };
  const args = [];
  let budgetCheck = { applicable: false, reason: 'No top-level server budget evaluation for this suite; inspect per-trial records.' };
  const allowedCars = config(root).suites[suite]?.cars;
  if (allowedCars && env.GP_CARS && env.GP_CARS !== 'all' && env.GP_CARS.split(',').some(car => !allowedCars.includes(car))) throw Error('Unknown selected competitor');
  if (['server', 'compression'].includes(suite)) {
    args.push('harness/ci-run.mjs');
    const events = eventSelection(suite === 'compression' ? '1,3,4,5,7' : env.GP_EVENTS || '1-8');
    const cars = env.GP_CARS || 'all';
    const applicable = suite === 'server' && (cars === 'all' || cars.split(',').includes('forma')) && ['sprint', 'fuel', 'grid', 'weight'].every(event => events.includes(event));
    budgetCheck = { applicable, reason: applicable ? 'All required Forma strength measurements were selected.' : 'Not applicable: requires Forma and server events 1,5,6,7.' };
    Object.assign(runtimeEnv, { GP_CARS: suite === 'compression' ? 'forma' : env.GP_CARS || 'all', GP_EVENTS: suite === 'compression' ? '1,3,4,5,7' : env.GP_EVENTS || '1-8',
      GP_FORMA_REF: refs[0] || '', GP_BASELINE: 'true', GP_COMPRESSION: String(suite === 'compression'), GP_CHECK_BUDGETS: String(budgetCheck.applicable) });
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
    } else args.push('harness/islands-linux.mjs', '--chrome', chrome, '--cars', env.GP_CARS && env.GP_CARS !== 'all' ? env.GP_CARS : config(root).suites.islands.cars.join(','));
    if (diagnostic) args.push('--diagnostic');
  }
  return { suite, profile, diagnostic, formaRefs: refs, budgetCheck, args, env: runtimeEnv };
}
export function beginAttempt(root, suite, env = process.env) {
  if (!SUITES.includes(suite)) throw Error('Unknown CI suite');
  const id = env.GP_RUN_ID, dir = runPath(root, id);
  if (fs.existsSync(dir)) throw Error('Run ID already exists; a prior attempt cannot be replaced');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(path.join(dir, 'artifacts'));
  const source = sourceIdentity(root);
  const requested = ['client', 'paired'].includes(suite) ? env.GP_FORMA_REFS || env.GP_CLIENT_REFS : suite === 'islands' ? '' : env.GP_FORMA_REF;
  const refs = (requested || '').split(',').filter(Boolean);
  const manifest = { schemaVersion: 1, id, protocolVersion: config(root).protocolVersion, testHash: source.testHash,
    status: 'preparing', quality: 'unqualified', mode: env.GP_DIAGNOSTIC === 'true' ? 'diagnostic' : 'qualified', startedAt: new Date().toISOString(),
    source, labSourceCommit: source.commit, formaSourceCommits: refs, environment: environment(),
    config: { suite, profile: env.GP_PROFILE || 'gha-4-v1', cars: env.GP_CARS || null, events: env.GP_EVENTS || null,
      compilerTemplates: env.GP_COMPILER_TEMPLATES === 'true', profileRows: env.GP_PROFILE_ROWS === 'true' },
    remote: { provider: 'github-actions', repository: env.GITHUB_REPOSITORY || null, runId: env.GITHUB_RUN_ID || null,
      runAttempt: env.GITHUB_RUN_ATTEMPT || null, job: env.GITHUB_JOB || null, requestId: env.GP_REQUEST_ID || null,
      url: env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null },
    note: 'Hosted attempt. Qualification is derived from original driver evidence, not job success alone.' };
  if (['server', 'islands'].includes(suite)) {
    try {
      const cars = !env.GP_CARS || env.GP_CARS === 'all' ? config(root).suites[suite].cars : env.GP_CARS.split(',');
      const events = suite === 'server' ? eventSelection(env.GP_EVENTS || '1-8') : ['islands'];
      manifest.expected = events.flatMap(event => cars.map(car => ({ event, car })));
    } catch (error) { manifest.selectionError = error.message; }
  }
  if (suite === 'client') {
    manifest.expected = ['published', ...refs].flatMap(ref => {
      const trial = `artifacts/${id}-client/${ref}`;
      const cars = ref === 'published' ? ['forma', 'vanilla', 'react', 'preact', 'solid', 'svelte', 'vue'] : ['forma', 'vanilla'];
      return [...['dom', 'bundle'].flatMap(event => cars.map(car => ({ event, car, trial }))),
        ...['forma', 'alien-signals', 'solid', 'preact-signals', 'vue-reactivity'].map(car => ({ event: 'signals', car, trial })),
        { event: 'signals-version-check', car: 'alien-signals-3.1.2', trial }];
    });
  }
  if (suite === 'paired') manifest.expected = ['published', ...refs].flatMap(ref => serverEvents.slice(0, 7).map(event => ({ event, car: 'forma', trial: `artifacts/${id}-paired/${ref}` })));
  if (suite === 'compression') manifest.expected = ['identity', 'br', 'gzip'].flatMap(encoding => eventSelection('1,3,4,5,7').map(event => ({ event, car: 'forma', trial: `artifacts/${id}-compression/${encoding}` })));
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
    const phaseSecret = randomBytes(32).toString('hex');
    const childEnv = { ...env, ...plan.env, GP_RESULTS_DIR: path.join(dir, 'artifacts'), GP_CI_PHASE_TOKEN: phaseSecret };
    if (suite !== 'server') delete childEnv.GP_CI_PHASE_TOKEN;
    for (const key of ['GP_RAW_DIR', 'GP_OUT', 'GP_CAMPAIGN_FILE', 'GP_CAMPAIGN_JSON', 'GP_RESOURCE_PROFILE', 'GP_IMAGE_PREFIX', 'GP_ACCEPT_ENCODING']) delete childEnv[key];
    code = await new Promise((resolve, reject) => {
      release.update({ phase: 'starting-worker' });
      const child = spawn(process.execPath, plan.args, { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      if (child.pid) release.update({ phase: 'running', workerPid: child.pid, ...(process.platform !== 'win32' ? { workerProcessGroup: child.pid } : {}) });
      const signal = name => { manifest.interrupted = true; try { if (process.platform !== 'win32') process.kill(-child.pid, name); else child.kill(name); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
      const stop = () => signal('SIGTERM'), interrupt = () => signal('SIGINT');
      process.once('SIGTERM', stop); process.once('SIGINT', interrupt);
      let cleared = false;
      const clear = () => { if (cleared) return; cleared = true; process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', interrupt); release.update({ phase: 'finishing' }); };
      for (const [pipe, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) pipe.on('data', data => { fs.writeSync(fd, data); output.write(data); });
      child.once('error', error => { clear(); reject(error); });
      child.once('close', status => { clear(); resolve(status ?? 1); });
    });
    if (suite === 'server' && plan.budgetCheck.applicable) {
      try { manifest.executionPhases = authenticatePhaseReceipt(safePath(dir, 'artifacts/' + PHASE_FILE), phaseSecret, manifest.id); }
      catch (error) { manifest.executionPhaseError = error.message; }
    }
    manifest.exitCode = code; manifest.status = manifest.interrupted ? 'interrupted' : code === 0 ? 'completed' : 'failed';
    manifest.sourceAfter = sourceIdentity(root).sourceHash;
    if (manifest.sourceAfter !== manifest.source.sourceHash) { manifest.status = 'invalid'; manifest.error = 'Laboratory inputs changed during execution'; code = 1; }
  } catch (error) { manifest.status = 'failed'; manifest.error = error.message; code = 1; }
  finally { if (fd !== undefined) fs.closeSync(fd); manifest.finishedAt = new Date().toISOString(); writeJSON(file, manifest); release(); }
  return code;
}
// Budget acceptance is a separate scientific question from measurement validity.
// A phase receipt proves the driver completed before the acceptance tool ran;
// its retained inputs and result are recomputed, never trusted as a pass/fail bit.
export function performanceAcceptance(dir, manifest) {
  if (manifest.config?.suite !== 'server' || !manifest.plan?.budgetCheck?.applicable) return { applicable: false, status: 'not-applicable', reason: manifest.plan?.budgetCheck?.reason || 'Server strength budgets were not selected.' };
  try {
    const phase = manifest.executionPhases;
    assert(phase && !manifest.executionPhaseError, 'No authenticated driver completion receipt');
    assert.equal(phase.runId, manifest.id); assert.equal(phase.driverExitCode, 0);
    assert.equal(phase.budget?.applicable, true); assert.equal(phase.budget.signal, null); assert.equal(phase.budget.error, null);
    assert([0, 1].includes(phase.budget.exitCode)); assert.equal(phase.budget.exitCode, manifest.exitCode);
    assert.equal(hash(fs.readFileSync(safePath(dir, 'artifacts/' + PHASE_FILE))), phase.receiptSha256, 'Phase receipt changed after capture');
    for (const file of BUDGET_FILES) assert.equal(hash(fs.readFileSync(safePath(dir, 'artifacts/' + file))), phase.files?.[file], 'Budget input changed: ' + file);
    const records = Object.fromEntries(['sprint', 'fuel', 'grid', 'weight'].map(event => [event, readJSON(safePath(dir, `artifacts/raw/${event}/forma.json`))]));
    const result = evaluateBudgets(records), saved = readJSON(safePath(dir, 'artifacts/raw/forma-budgets.json'));
    assert.deepEqual(saved, result, 'Stored budgets differ from recomputed unchanged thresholds');
    assert.equal(phase.budget.exitCode, result.passed ? 0 : 1, 'Budget exit does not match recomputed acceptance');
    return { applicable: true, status: result.passed ? 'met' : 'missed', evidence: 'artifacts/raw/forma-budgets.json', phaseReceipt: 'artifacts/' + PHASE_FILE,
      measured: result.measured, limits: result.limits, checks: result.checks, diagnostic: result.diagnostic,
      explanation: 'Performance acceptance is separate from evidence qualification. Missing a target is retained as an acceptance failure.' };
  } catch (error) { return { applicable: true, status: 'unverified', error: error.message }; }
}
export async function finishAttempt(root, suite, env = process.env) {
  const dir = runPath(root, env.GP_RUN_ID), file = path.join(dir, 'manifest.json');
  let manifest;
  if (!fs.existsSync(file)) manifest = beginAttempt(root, suite, env);
  else manifest = readJSON(file);
  if (manifest.config.suite !== suite) throw Error('Finalization suite differs');
  if (fs.existsSync(path.join(dir, 'integrity.json'))) throw Error('A sealed attempt cannot be finalized again');
  if (fs.existsSync(path.join(root, '.grandprix/active.json'))) {
    try {
      const recovery = planRecovery(root, { runId: manifest.id });
      if (recovery.blocked.length) throw Error(recovery.blocked.join(' '));
      applyRecovery(root, recovery); manifest = readJSON(file);
    } catch (error) { manifest.recoveryError = error.message; manifest.status = 'failed'; }
  }
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
  manifest.performanceAcceptance = performanceAcceptance(dir, manifest);
  const validEvidence = report?.measurements.length && report.measurements.every(m => m.qualification === 'qualified' && (m.status === 'measured' || (m.status === 'unavailable' && m.required === false)));
  const budgetOnlyFailure = manifest.status === 'failed' && manifest.exitCode === 1 && manifest.performanceAcceptance.status === 'missed'
    && manifest.performanceAcceptance.diagnostic === false && !manifest.interrupted && !manifest.error && !manifest.recoveryError && !manifest.reportError
    && manifest.sourceAfter === manifest.source.sourceHash && sourceIdentity(root).sourceHash === manifest.sourceAfter
    && validEvidence && manifest.cleanup?.completed === true && env.GP_WORKFLOW_STATUS === 'failure'
    && env.GP_MEASUREMENT_OUTCOME === 'failure' && env.GP_DOCKER_CLEANUP_OUTCOME === 'success';
  manifest.performanceAcceptance.onlyFailure = budgetOnlyFailure;
  manifest.workflowOutcomes = { measurement: env.GP_MEASUREMENT_OUTCOME || null, dockerCleanup: env.GP_DOCKER_CLEANUP_OUTCOME || null };
  manifest.quality = manifest.mode === 'diagnostic' ? 'diagnostic' : (manifest.status === 'completed' || budgetOnlyFailure) && manifest.cleanup?.completed === true && validEvidence ? 'qualified' : 'unqualified';
  manifest.workflowStatus = env.GP_WORKFLOW_STATUS || null; writeJSON(file, manifest);
  if (!manifest.reportError) generateReport(dir);
  seal(dir);
  return { id: manifest.id, status: manifest.status, quality: manifest.quality, directory: dir };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [operation, suite] = process.argv.slice(2);
    if (operation === 'begin') { const result = beginAttempt(ROOT, suite); console.log(`Retaining ${result.id}: laboratory ${result.labSourceCommit}; Forma ${result.formaSourceCommits.join(',') || 'published baseline'}`); }
    else if (operation === 'prepare') {
      if (!SUITES.includes(suite)) throw Error('Unknown CI suite');
      const refs = selectedRefs(suite, process.env);
      for (const ref of new Set(suite === 'islands' ? [] : [config(ROOT).baseline.sourceCommit, ...refs])) { ensureFormaSource(ref); console.log('Prepared exact Forma source ' + ref); }
    }
    else if (operation === 'run') process.exitCode = await captureAttempt(ROOT, suite);
    else if (operation === 'finish') console.log(JSON.stringify(await finishAttempt(ROOT, suite)));
    else throw Error('Usage: node src/ci-capture.mjs begin|prepare|run|finish server|client|islands|paired|compression');
  } catch (error) { console.error('Grand Prix CI: ' + error.message); process.exitCode = 1; }
}
