// Compact one completed, isolated client trial between measurements. Never follow links.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ownerFile = 'trial-ownership.json', receiptFile = 'cleanup-after-trial.json';
const digest = value => createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const freeBytes = directory => { const s = statfsSync(directory); return s.bavail * s.bsize; };
function safePath(root, relative) {
  let current = root;
  for (const part of relative.split(path.sep)) {
    assert(part && part !== '.' && part !== '..', 'invalid owned cleanup path');
    current = path.join(current, part);
    assert(!lstatSync(current).isSymbolicLink(), 'trial cleanup refuses a linked path: ' + relative);
  }
  return current;
}
function identity(directory, { runId, ref, labSourceCommit, profileRows = false }) {
  assert(/^[a-z0-9-]+$/.test(runId ?? ''), 'exact client run ID required');
  assert(ref === 'published' || /^[a-f0-9]{40}$/.test(ref ?? ''), 'exact trial source required');
  assert(/^[a-f0-9]{40}$/.test(labSourceCommit ?? ''), 'exact laboratory commit required');
  assert.equal(typeof profileRows, 'boolean', 'profiling selection required');
  directory = path.resolve(directory);
  assert.equal(realpathSync(directory), directory, 'trial directory must not follow symbolic links');
  assert.equal(path.basename(directory), ref, 'trial directory differs from source');
  assert.equal(path.basename(path.dirname(directory)), `${runId}-client`, 'trial directory differs from run');
  return { schema: 1, owner: 'forma-grand-prix-client-trial', runId, ref, labSourceCommit, profileRows };
}
export function ownClientTrial(directory, options) {
  const owner = identity(directory, options);
  assert.deepEqual(readdirSync(directory), [], 'ownership requires a fresh empty trial directory');
  writeFileSync(path.join(directory, ownerFile), JSON.stringify(owner, null, 2) + '\n', { flag: 'wx' });
  return owner;
}
function inventory(directory) {
  let bytes = 0, files = 0;
  const entries = [];
  function walk(file, relative) {
    const stat = lstatSync(file);
    entries.push([relative, stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs]);
    if (stat.isDirectory()) for (const name of readdirSync(file).sort()) walk(path.join(file, name), relative + '/' + name);
    else { files++; bytes += stat.size; } // Symlink entries are counted, never followed.
  }
  walk(directory, '.');
  return { bytes, files, inventorySha256: digest(JSON.stringify(entries)) };
}
function candidates(directory) {
  const found = [], generated = new Set(['node_modules', 'dist', 'target']);
  function walk(folder, relative) {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = `${relative}/${entry.name}`, file = path.join(folder, entry.name);
      if (generated.has(entry.name) && entry.isSymbolicLink()) throw Error('trial cleanup refuses a linked generated path: ' + name);
      if (!entry.isDirectory()) continue;
      if (generated.has(entry.name)) { found.push({ path: name, ...inventory(file) }); continue; }
      if (['raw', 'evidence', 'report', '.git'].includes(entry.name)) continue;
      walk(file, name);
    }
  }
  for (const workspace of ['client-race', 'signals-race', 'candidate']) {
    if (existsSync(path.join(directory, workspace))) walk(safePath(directory, workspace), workspace);
  }
  return found;
}
export function compactClientTrial(directory, options) {
  const expected = identity(directory, options);
  directory = path.resolve(directory);
  assert.deepEqual(read(safePath(directory, ownerFile)), expected, 'trial ownership differs');
  const driver = read(safePath(path.dirname(directory), 'run.json'));
  assert.equal(driver.id, expected.runId, 'client driver belongs to another run');
  assert.equal(driver.labSourceCommit, expected.labSourceCommit, 'client driver laboratory commit differs');
  const matching = driver.trials?.filter(trial => trial.ref === expected.ref) || [];
  assert.equal(matching.length, 1, 'one completed driver trial required');
  assert.equal(matching[0].passed, true, 'unfinished trial cannot be compacted');
  assert.equal(matching[0].labSourceCommit, expected.labSourceCommit, 'trial laboratory commit differs');
  assert.equal(matching[0].formaSourceCommit, expected.ref === 'published' ? null : expected.ref, 'trial framework commit differs');
  if (options.profileRows) {
    for (const car of ['forma', 'vanilla']) assert(driver.rowProfiles?.some(row => row.ref === expected.ref && row.car === car && row.diagnostic === true), 'row profiling must finish before trial cleanup');
  }
  const file = path.join(directory, receiptFile);
  assert(!existsSync(file), 'trial cleanup receipt already exists');
  const files = candidates(directory), receipt = { ...expected, startedAt: new Date().toISOString(),
    phase: options.profileRows ? 'after-row-profiles' : 'after-measurements', freeBytesBefore: freeBytes(directory),
    plannedBytes: files.reduce((sum, item) => sum + item.bytes, 0), planned: files, actions: [], completed: false };
  writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  const save = () => writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n');
  try {
    for (const item of files) {
      const target = safePath(directory, item.path);
      assert.deepEqual(inventory(target), { bytes: item.bytes, files: item.files, inventorySha256: item.inventorySha256 }, 'trial output changed before cleanup');
      rmSync(target, { recursive: true });
      receipt.actions.push(item); save();
    }
    receipt.completed = true;
  } catch (error) { receipt.error = error.message; throw error; }
  finally { receipt.finishedAt = new Date().toISOString(); receipt.freeBytesAfter = freeBytes(directory); save(); }
  return { receipt: receiptFile, completed: receipt.completed, plannedBytes: receipt.plannedBytes, removedDirectories: receipt.actions.length };
}
