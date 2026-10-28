// Offline disposable Git repositories for source-provenance refusal controls.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const laboratoryRoot = fileURLToPath(new URL('..', import.meta.url));
export function sourceFixture(test) {
  const directory = mkdtempSync(join(tmpdir(), 'gp-source-fixture-'));
  test.after(() => rmSync(directory, { recursive: true, force: true }));
  const laboratory = join(directory, 'lab'), forma = join(directory, 'forma');
  const url = 'https://github.com/getforma-dev/forma.git';
  const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (root, file, text) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); };
  for (const root of [laboratory, forma]) { mkdirSync(root); git(root, 'init', '--initial-branch=main'); }
  write(laboratory, 'config/laboratory.json', JSON.stringify({ formaSource: { repositoryUrl: url, cacheDirectory: '.grandprix/sources/forma.git' } }));
  cpSync(join(laboratoryRoot, 'contestants'), join(laboratory, 'contestants'), { recursive: true });
  mkdirSync(join(laboratory, 'harness'));
  for (const file of ['candidate-lock.mjs', 'compression-codecs.json']) cpSync(join(laboratoryRoot, 'harness', file), join(laboratory, 'harness', file));
  write(forma, 'Cargo.toml', '[workspace]\nresolver = "2"\n[workspace.package]\nversion = "3.2.0"\n');
  write(forma, 'Cargo.lock', '# Synthetic source fixture; no dependency resolution.\n');
  for (const name of ['forma-ir', 'forma-ir-derive', 'forma-server']) write(forma, `crates/${name}/Cargo.toml`, `[package]\nname = "${name}"\nversion.workspace = true\n`);
  write(forma, 'packages/core/source.txt', 'framework source from the explicit repository\n');
  write(forma, 'benchmarks/grand-prix/contestants/historical/source.txt', 'frozen adapter comes from Forma history\n');
  git(forma, 'remote', 'add', 'origin', url);
  for (const root of [laboratory, forma]) { git(root, 'add', '.'); git(root, '-c', 'user.name=Grand Prix Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Synthetic source fixture'); }
  return { directory, laboratory, forma, url, git, write, labCommit: git(laboratory, 'rev-parse', 'HEAD'), formaCommit: git(forma, 'rev-parse', 'HEAD') };
}
