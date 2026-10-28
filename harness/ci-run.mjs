import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ensureFormaSource } from './forma-source.mjs';

export const PHASE_FILE = 'ci-phases.json';
export const BUDGET_FILES = ['raw/forma-budgets.json', ...['sprint', 'fuel', 'grid', 'weight'].map(event => `raw/${event}/forma.json`)];
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function authenticatePhaseReceipt(file, secret, runId) {
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(receipt.algorithm, 'hmac-sha256');
  assert.equal(receipt.payload?.schemaVersion, 1); assert.equal(receipt.payload.runId, runId);
  assert(/^[a-f0-9]{64}$/.test(receipt.signature || ''), 'Invalid phase receipt signature');
  const expected = createHmac('sha256', secret).update(JSON.stringify(receipt.payload)).digest();
  assert(timingSafeEqual(expected, Buffer.from(receipt.signature, 'hex')), 'Phase receipt authentication failed');
  return { ...receipt.payload, receiptSha256: digest(file) };
}
export function runServerCI({ env = process.env, cwd = process.cwd(), spawn = spawnSync, prepare = ensureFormaSource } = {}) {
  const secret = env.GP_CI_PHASE_TOKEN;
  const workerEnv = { ...env }; delete workerEnv.GP_CI_PHASE_TOKEN;
  // Only this wrapper authenticates the phase boundary; measured children,
  // source preparation and budget tools never inherit the one-use key.
  if (env === process.env) delete process.env.GP_CI_PHASE_TOKEN;
  const args = ['harness/linux-run.mjs'];
  if (env.GP_CARS && env.GP_CARS !== 'all') args.push('--cars', env.GP_CARS);
  const compression = env.GP_COMPRESSION === 'true';
  args.push('--events', compression ? '1,3,4,5,7' : env.GP_EVENTS || '1-8');
  if (compression) args.push('--compression');
  if (env.GP_DIAGNOSTIC !== 'false') args.push('--diagnostic');
  if (env.GP_BASELINE !== 'false') args.push('--baseline');
  if (env.GP_FORMA_REF) { assert(/^[a-f0-9]{40}$/.test(env.GP_FORMA_REF)); prepare(env.GP_FORMA_REF); args.push('--forma-ref', env.GP_FORMA_REF); }
  const result = spawn(process.execPath, args, { cwd, stdio: 'inherit', env: workerEnv });
  if (result.status !== 0 || result.error || result.signal) return result.status || 1;
  const applicable = env.GP_CHECK_BUDGETS === 'true' && !compression;
  let code = 0, check;
  if (applicable) { check = spawn(process.execPath, ['harness/budgets.mjs'], { cwd, stdio: 'inherit', env: workerEnv }); code = check.status ?? 1; if (check.error || check.signal) code ||= 1; }
  if (secret && env.GP_RESULTS_DIR && env.GP_RUN_ID) {
    assert(/^[a-f0-9]{64}$/.test(secret), 'Invalid phase receipt key');
    const files = Object.fromEntries((applicable ? BUDGET_FILES : []).filter(file => fs.existsSync(path.join(env.GP_RESULTS_DIR, file))).map(file => [file, digest(path.join(env.GP_RESULTS_DIR, file))]));
    const payload = { schemaVersion: 1, runId: env.GP_RUN_ID, driverExitCode: 0,
      budget: { applicable, exitCode: code, signal: check?.signal || null, error: check?.error?.message || null }, files };
    const signature = createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
    fs.writeFileSync(path.join(env.GP_RESULTS_DIR, PHASE_FILE), JSON.stringify({ algorithm: 'hmac-sha256', payload, signature }, null, 2) + '\n', { flag: 'wx' });
  }
  return code;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = runServerCI();
