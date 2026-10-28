import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
test('frozen evidence and original protocols survive extraction byte for byte', () => {
  const receipt = JSON.parse(fs.readFileSync(path.join(root, 'migration-source.json')));
  assert.equal(receipt.sourceRepository, 'https://github.com/getforma-dev/forma');
  assert.match(receipt.sourceCommit, /^[a-f0-9]{40}$/);
  const frozen = Object.entries(receipt.files).filter(([file]) => file.startsWith('evidence/') || ['PROTOCOL.md', 'ROUND-2.md', 'CONTRACT.md', 'baseline-source.json'].includes(file));
  assert(frozen.length >= 185, 'preserve the original evidence inventory');
  for (const [file, digest] of frozen) {
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'), digest, file);
  }
});
