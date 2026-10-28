import assert from 'node:assert/strict';

// Sequential isolation: an entrant's cleanup completes before another can start.
// Only the caller's explicit, evidence-backed classification permits continuation.
export async function runEntrantSequence({ cars, beforeEach, execute, cleanup, recoverable, onStep = () => {} }) {
  const steps = []; let aborted = false, error;
  for (const car of cars) {
    const step = { car, status: 'running', phase: 'preflight', startedAt: new Date().toISOString() };
    steps.push(step); onStep(step);
    let continueSafely = true;
    const phase = name => { step.phase = name; onStep(step); };
    try {
      await beforeEach(car, step); await execute(car, phase, step); step.status = 'completed';
    } catch (failure) {
      step.status = step.phase === 'preflight' ? 'blocked' : 'failed'; step.error = String(failure);
      if (Number.isInteger(failure.exitCode)) step.exitCode = failure.exitCode;
      if (failure.signal) step.signal = failure.signal;
      try { continueSafely = await recoverable(failure, step); }
      catch (guardError) { continueSafely = false; step.continuationError = String(guardError); }
      step.continuable = continueSafely;
    } finally {
      try { await cleanup(car, step); step.cleanup = { completed: true }; }
      catch (cleanupError) { step.cleanup = { completed: false, error: String(cleanupError) }; step.status = 'failed'; continueSafely = false; }
      step.finishedAt = new Date().toISOString(); onStep(step);
    }
    if (!continueSafely) { aborted = true; error = step.continuationError || step.cleanup.error || step.error; break; }
  }
  const failures = steps.filter(step => step.status !== 'completed');
  return { steps, failures, aborted, error, skippedCars: cars.slice(steps.length), passed: !aborted && failures.length === 0 };
}

export function assertOwnedEntrantImage(image, tag, runId) {
  assert(/^sha256:[a-f0-9]{64}$/.test(image?.Id || ''), 'Missing exact entrant image identity');
  assert(image.RepoTags?.some(value => value === tag || value === tag + ':latest'), 'Entrant image tag differs');
  assert.equal(image.Config?.Labels?.grandprix, 'forma-264', 'Entrant image laboratory ownership differs');
  assert.equal(image.Config?.Labels?.gp264run, runId, 'Entrant image run ownership differs');
}

export function assertEntrantRaceFailure(receipt, car, runId, campaign) {
  assert.equal(receipt?.runId, runId, 'race receipt run differs');
  assert.deepEqual(receipt.cars, [car], 'race receipt entrant differs');
  assert.deepEqual(receipt.campaign, campaign, 'race receipt campaign differs');
  assert(receipt.finished && Array.isArray(receipt.failures) && receipt.failures.length, 'failed race lacks explicit entrant failures');
  assert(receipt.failures.every(failure => failure.car === car && (failure.event === 'smoke' || failure.event === '1+5' || Number.isInteger(failure.event) && failure.event >= 1 && failure.event <= 8)), 'failure is not scoped to this entrant');
  const fatal = /\b(?:quota|affinity|cpuset)\b|worker count drift|cannot verify container resource limits|resource profile|resource role|machine fingerprint|host campaign|run interrupted|quiet machine|free disk/i;
  assert(receipt.failures.every(failure => !fatal.test(failure.error || '')), 'host or resource failure cannot continue');
}
