import { createCampaign } from './campaign.mjs';
import { sourceConfiguration } from './forma-source.mjs';
import { entrantsFor } from './registry.mjs';
// One owned, sequential Linux run. No resource outside this run is pruned.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, readFileSync, statfsSync } from 'node:fs';
import os from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCars, BASELINE_SOURCE } from './prepare-car.mjs';
import { hostProfile, validateEngineProfile } from './resource-profile.mjs';
import { runEntrantSequence, assertOwnedEntrantImage, assertEntrantRaceFailure } from './entrant-sequence.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert(!process.env.GP_RAW_DIR && !process.env.GP_ACCEPT_ENCODING, 'this driver owns raw-output and request-encoding selection');
const argv = process.argv.slice(2);
const option = (name, fallback) => argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback;
const allCars = entrantsFor('server');
const cars = option('cars', allCars.join(',')).split(',');
assert(cars.length && new Set(cars).size === cars.length && cars.every(car => allCars.includes(car)), 'invalid car set');
const events = option('events', '1-8');
assert(/^[1-8,-]+$/.test(events), 'server event selector must use 1–8');
const diagnostic = argv.includes('--diagnostic');
const baseline = argv.includes('--baseline');
const formaRef = option('forma-ref', undefined);
const compression = argv.includes('--compression');
if (compression) {
  assert(formaRef && baseline && cars.length === 1 && cars[0] === 'forma', 'compression needs an exact ref and only the frozen Forma car');
  assert.equal(events, '1,3,4,5,7', 'compression profile requires events 1,3,4,5,7');
}
assert.equal(process.platform, 'linux', 'this runner is for native Linux');
process.env.GP_DIAGNOSTIC = String(diagnostic);
const resourceProfile = hostProfile({ diagnostic });
process.env.GP_PROFILE = resourceProfile.name;
const dockerEngine = validateEngineProfile(resourceProfile, JSON.parse(execFileSync('docker', ['info', '--format', '{{json .}}'], { encoding: 'utf8' })));
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' });
assert.equal(dirty.trim(), '', 'commit all laboratory source before racing');
const id = process.env.GP_RUN_ID || `r${Date.now().toString(36)}-${process.pid}`;
assert(/^[a-z0-9-]+$/.test(id), 'invalid run ID');
process.env.GP_RUN_ID = id;
process.env.GP_IMAGE_PREFIX = `gp264/${id}`;
const imageName = car => `${process.env.GP_IMAGE_PREFIX}/${car}`;
const builder = `gp264-${id}`;
const label = `gp264run=${id}`;
const results = resolve(process.env.GP_RESULTS_DIR || join(root, 'results'));
mkdirSync(results, { recursive: true });
assert(!existsSync(join(results, 'raw')), 'fresh raw directory required; archive prior evidence first');
const ownershipPath = join(results, `${id}-ownership.json`);
assert(!existsSync(ownershipPath), 'run ID already used');
const ownership = { id, builder, builderCreated: false };
const campaign = createCampaign(join(results, `${id}-campaign.json`));
const labSourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const report = { schema: 2, id, campaign, diagnostic, resourceProfile, dockerEngine, cars, events, platform: process.platform, arch: process.arch,
  carSource: baseline ? BASELINE_SOURCE : 'current checkout', formaRef: formaRef ?? 'published 3.0.0', compression,
  cpus: os.availableParallelism(), cpu: os.cpus()[0]?.model, kernel: os.release(), memoryBytes: os.totalmem(),
  sourceCommit: labSourceCommit, sourceCommitKind: 'laboratory', labSourceCommit,
  formaSourceCommit: formaRef ?? null, formaSourceKind: formaRef ? 'exact-source' : 'locked-registry', formaRepositoryUrl: sourceConfiguration(root).repositoryUrl,
  before: new Date().toISOString(), freeBefore: free(), steps: [], passed: false };
const save = () => writeFileSync(join(results, `${id}-linux.json`), JSON.stringify(report, null, 2) + '\n');
function free() { const stat = statfsSync(root); return stat.bavail * stat.bsize; }
function checkDisk() { assert(free() >= 4 * 1024 ** 3, 'free disk below 4 GiB; stop before another build'); }
let child;
function run(program, args, cwd = root) {
  console.log(JSON.stringify([program, ...args]));
  return new Promise((ok, fail) => {
    child = spawn(program, args, { cwd, stdio: 'inherit', env: process.env });
    child.once('error', fail);
    child.once('close', (code, signal) => { child = undefined; if (code === 0) ok(); else { const error = new Error(`${program} exited ${code}${signal ? ' (' + signal + ')' : ''}`); error.exitCode = code; error.signal = signal; fail(error); } });
  });
}
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping = true; child?.kill(signal); });
async function quiet() {
  const deadline = Date.now() + 5 * 60_000;
  while (os.loadavg()[0] >= 2 && Date.now() < deadline && !stopping) {
    console.log(`settling after build; load=${os.loadavg()[0].toFixed(2)}`);
    await new Promise(resolve => setTimeout(resolve, 10_000));
  }
  assert(!stopping, 'run interrupted');
  assert(os.loadavg()[0] < 2, 'machine did not settle below load 2');
}
const buildArgs = ['buildx', 'build', '--builder', builder, '--load', '--label', 'grandprix=forma-264', '--label', label];
async function build(car, context) {
  checkDisk();
  await run('docker', [...buildArgs, '-t', imageName(car), context]);
  await run('docker', [...buildArgs, '--target', 'build', '-t', imageName(car + '-build'), context]);
}
function checkCampaignSafety() {
  assert(!stopping, 'run interrupted'); checkDisk();
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), labSourceCommit, 'laboratory source commit changed');
  assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' }).trim(), '', 'laboratory source changed');
  assert.deepEqual(hostProfile({ diagnostic }), resourceProfile, 'host resource profile changed');
  validateEngineProfile(resourceProfile, JSON.parse(execFileSync('docker', ['info', '--format', '{{json .}}'], { encoding: 'utf8' })));
}
function retainRaceReceipt(car, step) {
  const raw = join(results, 'raw', `_run-${id}.json`);
  assert(existsSync(raw), 'race did not produce its completed entrant receipt');
  const receipt = JSON.parse(readFileSync(raw, 'utf8'));
  assert.equal(receipt.runId, id, 'race receipt run differs'); assert.deepEqual(receipt.cars, [car], 'race receipt entrant differs');
  assert.deepEqual(receipt.campaign, campaign, 'race receipt campaign differs');
  const relative = `${id}-entrant-${car}-race.json`;
  assert(!existsSync(join(results, relative)), 'entrant race receipt already retained');
  writeFileSync(join(results, relative), JSON.stringify(receipt, null, 2) + '\n'); step.raceReceipt = relative;
}
async function mayContinue(error, step) {
  if (stopping || error.signal || error.exitCode !== 1 || !['build', 'race'].includes(step.phase)) return false;
  checkCampaignSafety();
  if (step.phase === 'race') {
    assert(step.raceReceipt, 'failed race did not produce its own completed receipt');
    const receipt = JSON.parse(readFileSync(join(results, step.raceReceipt), 'utf8'));
    assertEntrantRaceFailure(receipt, step.car, id, campaign);
  }
  return true;
}
async function cleanupEntrant(car) {
  // A race trap is best-effort; confirm no owned process/network remains before
  // proceeding. The shared load-generator image and other tags are untouched.
  const errors = [], attempt = async action => { try { await action(); } catch (error) { errors.push(String(error)); } };
  for (const [query, remove] of [[['ps', '-aq'], ['rm', '-f']], [['network', 'ls', '-q'], ['network', 'rm']]]) await attempt(async () => {
    const ids = execFileSync('docker', [...query, '--filter', 'label=' + label], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
    if (ids.length) await run('docker', [...remove, ...ids]);
  });
  for (const tag of [imageName(car), imageName(car + '-build')]) await attempt(async () => {
    const present = execFileSync('docker', ['image', 'ls', '--quiet', '--no-trunc', '--filter', 'reference=' + tag], { encoding: 'utf8' }).trim();
    if (!present) return;
    const image = JSON.parse(execFileSync('docker', ['image', 'inspect', tag], { encoding: 'utf8' }))[0];
    assertOwnedEntrantImage(image, tag, id); await run('docker', ['image', 'rm', tag]);
  });
  await attempt(async () => {
    assert(ownership.builderCreated && ownership.builder === builder, 'builder ownership is not established');
    await run('docker', ['buildx', 'prune', '--builder', builder, '--all', '--force']);
  });
  assert.equal(errors.length, 0, 'entrant cleanup incomplete: ' + errors.join('; '));
}

try {
  checkDisk();
  const contexts = prepareCars(root, join(results, `${id}-contexts`), { baseline, formaRef, compression });
  await run('docker', ['buildx', 'create', '--name', builder, '--driver', 'docker-container']);
  ownership.builderCreated = true;
  writeFileSync(ownershipPath, JSON.stringify(ownership));
  await run('docker', [...buildArgs, '-t', imageName('loadgen'), 'harness/loadgen']);
  const sequence = await runEntrantSequence({ cars, beforeEach: checkCampaignSafety, cleanup: cleanupEntrant, recoverable: mayContinue,
    onStep: step => { const index = report.steps.findIndex(existing => existing.car === step.car); if (index < 0) report.steps.push(step); else report.steps[index] = step; save(); },
    execute: async (car, phase, step) => {
      phase('build');
      await build(car, join(contexts, car));
      if (car === 'forma') {
        const bytes = execFileSync('docker', ['run', '--rm', '--label', label, imageName('forma-build'),
          'stat', '-c', '%s', '/app/target/release/grandprix-forma'], { encoding: 'utf8' }).trim();
        report.releaseBinaryBytes = Number(bytes);
        if (formaRef) for (const file of ['Cargo.lock', 'candidate-source.json', 'candidate-metadata.json']) {
          writeFileSync(join(results, `${id}-forma-${file}`),
            execFileSync('docker', ['run', '--rm', '--label', label, imageName('forma-build'), 'cat', `/app/${file}`],
              { maxBuffer: 16 * 1024 * 1024 }));
        }
      }
      phase('settling'); await quiet();
      Object.assign(step, { at: new Date().toISOString(), load: os.loadavg(), freeBytes: free() });
      phase('race');
      if (compression) {
        const directory = join(results, `${id}-compression`);
        assert(!existsSync(directory), 'fresh compression observations required'); mkdirSync(directory);
        try {
          for (const encoding of ['identity', 'br', 'gzip']) {
            await quiet();
            process.env.GP_ACCEPT_ENCODING = encoding;
            process.env.GP_RAW_DIR = join(directory, encoding);
            assert(!existsSync(process.env.GP_RAW_DIR));
            await run(process.execPath, ['harness/race.mjs', '--cars', car, '--events', events]);
          }
        } finally { delete process.env.GP_ACCEPT_ENCODING; delete process.env.GP_RAW_DIR; }
        await run(process.execPath, ['harness/compression-report.mjs', directory, ...(diagnostic ? ['--diagnostic'] : [])]);
        report.compressionEvidence = directory;
      } else {
        try { await run(process.execPath, ['harness/race.mjs', '--cars', car, '--events', events]); }
        finally { retainRaceReceipt(car, step); }
      }
      step.loadAfter = os.loadavg(); save();
      phase('analysis');
      if (car === 'forma') {
        const sourceImage = JSON.parse(execFileSync('docker', ['image', 'inspect', imageName(car)], { encoding: 'utf8' }))[0].Id;
        const comparison = join(results, `${id}-runtime`);
        const sourceArgs = ['--lab-source-commit', labSourceCommit, '--source-kind', formaRef ? 'framework-candidate' : baseline ? 'forma-baseline-adapter' : 'laboratory-adapter', ...(formaRef ? ['--forma-source-commit', formaRef] : [])];
        await run(process.execPath, ['harness/compare-runtime.mjs', '--source-image', sourceImage,
          '--source-commit', formaRef ?? (baseline ? BASELINE_SOURCE : labSourceCommit), ...sourceArgs,
          '--builder', builder, '--out', comparison]);
        report.runtimeComparison = { directory: comparison, sourceImage }; save();
        if (!compression) {
          const buildImage = JSON.parse(execFileSync('docker', ['image', 'inspect', imageName('forma-build')], { encoding: 'utf8' }))[0].Id;
          const counts = join(results, `${id}-render-counts`);
          await run(process.execPath, ['harness/render-counts.mjs', '--runtime-image', sourceImage,
            '--build-image', buildImage, '--source-commit', formaRef ?? (baseline ? BASELINE_SOURCE : labSourceCommit), ...sourceArgs,
            '--out', counts, ...(diagnostic ? ['--diagnostic'] : [])]);
          report.renderCounts = { directory: counts, runtimeImage: sourceImage, buildImage }; save();
        }
      }
    }
  });
  report.passed = sequence.passed; report.failures = sequence.failures; report.skippedCars = sequence.skippedCars;
  if (sequence.aborted) { report.aborted = true; report.error = sequence.error; }
  if (!sequence.passed) process.exitCode = 1;
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally {
  save();
  try { await run(process.execPath, ['harness/cleanup.mjs']); }
  catch (error) { report.cleanupError = String(error); report.passed = false; process.exitCode = 1; }
  report.freeAfter = free(); report.finished = new Date().toISOString(); save();
}
