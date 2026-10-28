// Framework objects live in an explicitly identified source repository, never the lab's Git history.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const LAB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exact = ref => assert(/^[a-f0-9]{40}$/.test(ref ?? ''), 'Forma source must be an exact 40-character commit SHA');
const git = (repository, args, options = {}) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
  cwd: repository, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000, ...options,
});
export function repositoryIdentity(url) {
  const ssh = /^git@([^:]+):(.+)$/.exec(url);
  if (ssh) return `${ssh[1].toLowerCase()}/${ssh[2].replace(/\.git$/, '').replace(/\/$/, '')}`;
  const parsed = new URL(url);
  assert(['https:', 'ssh:'].includes(parsed.protocol) && !parsed.password && !parsed.search && !parsed.hash, 'unsupported source repository URL');
  if (parsed.protocol === 'https:') assert(!parsed.username, 'source URL must not contain credentials');
  return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\.git$/, '').replace(/\/$/, '')}`;
}
export function sourceConfiguration(root = LAB_ROOT) {
  const configured = JSON.parse(readFileSync(join(root, 'config/laboratory.json'), 'utf8')).formaSource;
  assert(configured && typeof configured.repositoryUrl === 'string', 'config/laboratory.json must declare formaSource.repositoryUrl');
  repositoryIdentity(configured.repositoryUrl);
  assert(typeof configured.cacheDirectory === 'string' && !isAbsolute(configured.cacheDirectory) && !configured.cacheDirectory.split('/').includes('..'), 'source cache must be relative to the laboratory');
  assert(configured.cacheDirectory.startsWith('.grandprix/'), 'source cache must be under the ignored .grandprix directory');
  return configured;
}
function safeCache(root, location) {
  const target = resolve(root, location);
  let next = root;
  for (const part of relative(root, target).split('/')) {
    next = join(next, part);
    if (existsSync(next)) assert(!lstatSync(next).isSymbolicLink(), 'source cache must not follow symbolic links');
  }
  return target;
}
export function ensureFormaSource(ref, { root = LAB_ROOT, repository = process.env.GP_FORMA_SOURCE_REPO, fetch = true } = {}) {
  exact(ref);
  const config = sourceConfiguration(root);
  let managed = false;
  if (repository) repository = realpathSync(resolve(repository));
  else {
    managed = true;
    repository = safeCache(root, config.cacheDirectory);
    const marker = join(repository, 'grandprix-source.json');
    if (!existsSync(repository)) {
      mkdirSync(dirname(repository), { recursive: true });
      git(root, ['init', '--bare', repository]);
      git(repository, ['remote', 'add', 'origin', config.repositoryUrl]);
      writeFileSync(marker, JSON.stringify({ schema: 1, owner: 'forma-grand-prix-source-cache', repositoryUrl: config.repositoryUrl }) + '\n', { flag: 'wx' });
    } else {
      assert(existsSync(marker), 'refusing unowned source cache; provide GP_FORMA_SOURCE_REPO explicitly');
      const receipt = JSON.parse(readFileSync(marker, 'utf8'));
      assert(receipt.schema === 1 && receipt.owner === 'forma-grand-prix-source-cache' && receipt.repositoryUrl === config.repositoryUrl, 'source cache ownership mismatch');
    }
  }
  const remote = git(repository, ['remote', 'get-url', 'origin']).trim();
  assert.equal(repositoryIdentity(remote), repositoryIdentity(config.repositoryUrl), 'Forma source origin differs from the configured repository');
  const hasCommit = () => spawnSync('git', ['cat-file', '-e', `${ref}^{commit}`], { cwd: repository, stdio: 'ignore' }).status === 0;
  if (!hasCommit()) {
    assert(fetch, 'exact Forma commit is missing from the selected source repository');
    git(repository, ['fetch', '--no-tags', '--depth=1', 'origin', ref]);
  }
  assert(hasCommit(), 'fetched Forma commit is unavailable');
  assert.equal(git(repository, ['rev-parse', `${ref}^{commit}`]).trim(), ref, 'Forma source identity mismatch');
  return { repository, repositoryUrl: config.repositoryUrl, commit: ref, managed };
}
function validPaths(paths) {
  assert(Array.isArray(paths) && paths.length && paths.every(p => typeof p === 'string' && p && !p.startsWith('-') && !isAbsolute(p) && !p.includes(':') && !p.includes('\\') && !p.split('/').includes('..')), 'archive paths must be safe repository-relative paths');
}
export function archiveForma(ref, paths, destination, options = {}) {
  if (options.tree) validPaths([options.tree]); else validPaths(paths);
  const source = ensureFormaSource(ref, options);
  const args = options.tree ? ['archive', `${ref}:${options.tree}`] : ['archive', ref, ...paths];
  const bytes = git(source.repository, args, { encoding: undefined, maxBuffer: 128 * 1024 ** 2 });
  mkdirSync(destination); // A fresh destination is mandatory; never merge evidence/work trees.
  execFileSync('tar', ['-xf', '-', '-C', destination], { input: bytes });
  return { repositoryUrl: source.repositoryUrl, commit: ref, tree: options.tree ?? null, paths: options.tree ? null : paths };
}
export function archiveLabContestants(destination, labCommit, { root = LAB_ROOT } = {}) {
  exact(labCommit);
  const repository = git(root, ['rev-parse', '--show-toplevel']).trim();
  assert.equal(realpathSync(repository), realpathSync(root), 'laboratory must be its own repository root');
  const bytes = git(repository, ['archive', `${labCommit}:contestants`], { encoding: undefined, maxBuffer: 64 * 1024 ** 2 });
  mkdirSync(destination);
  execFileSync('tar', ['-xf', '-', '-C', destination], { input: bytes });
  return { repository: 'laboratory', commit: labCommit, tree: 'contestants' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert(args.length === 2 && args[0] === '--prepare', 'Usage: node harness/forma-source.mjs --prepare <exact Forma commit>');
  const source = ensureFormaSource(args[1]);
  console.log(JSON.stringify({ repositoryUrl: source.repositoryUrl, commit: source.commit, managedCache: source.managed }, null, 2));
}
