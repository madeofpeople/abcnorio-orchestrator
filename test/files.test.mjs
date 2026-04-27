import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'abcnorio-orchestrator-test-'));
process.env.ASTRO_SITE_ROOT = tempRoot;

const {
  assertDeployPath,
  resolveArchiveForTarget,
  listArchivesForTarget,
} = await import('../files.mjs');

const archiveDir = path.join(tempRoot, 'build-archives');

function resetArchiveDir() {
  fs.mkdirSync(archiveDir, { recursive: true });
  for (const name of fs.readdirSync(archiveDir)) {
    fs.rmSync(path.join(archiveDir, name), { recursive: true, force: true });
  }
}

test('listArchivesForTarget only returns matching target zip archives', () => {
  resetArchiveDir();

  fs.writeFileSync(path.join(archiveDir, 'abcnorio-astro-dev-20260427-1200.zip'), 'x');
  fs.writeFileSync(path.join(archiveDir, 'abcnorio-astro-staging-20260427-1201.zip'), 'x');
  fs.writeFileSync(path.join(archiveDir, 'abcnorio-astro-dev-20260427-1200.txt'), 'x');

  const result = listArchivesForTarget('dev');

  assert.equal(result.length, 1);
  assert.equal(result[0], 'abcnorio-astro-dev-20260427-1200.zip');
});

test('resolveArchiveForTarget accepts valid archive in archive dir', () => {
  resetArchiveDir();

  const fileName = 'abcnorio-astro-dev-20260427-1200.zip';
  const archivePath = path.join(archiveDir, fileName);
  fs.writeFileSync(archivePath, 'x');

  const resolved = resolveArchiveForTarget('dev', fileName);

  assert.equal(resolved, archivePath);
});

test('resolveArchiveForTarget rejects invalid prefix', () => {
  resetArchiveDir();

  fs.writeFileSync(path.join(archiveDir, 'abcnorio-astro-staging-20260427-1200.zip'), 'x');

  assert.throws(
    () => resolveArchiveForTarget('dev', 'abcnorio-astro-staging-20260427-1200.zip'),
    /invalid archive/
  );
});

test('resolveArchiveForTarget rejects traversal-like filenames', () => {
  resetArchiveDir();

  assert.throws(
    () => resolveArchiveForTarget('dev', 'abcnorio-astro-dev-../bad.zip'),
    /invalid archive/
  );

  assert.throws(
    () => resolveArchiveForTarget('dev', '../abcnorio-astro-dev-20260427-1200.zip'),
    /invalid archive/
  );
});

test('resolveArchiveForTarget rejects missing file', () => {
  resetArchiveDir();

  assert.throws(
    () => resolveArchiveForTarget('dev', 'abcnorio-astro-dev-20260427-1200.zip'),
    /archive not found/
  );
});

test('assertDeployPath returns path for existing directory', () => {
  const deployDir = path.join(tempRoot, 'deploy-dev');
  fs.mkdirSync(deployDir, { recursive: true });

  const resolved = assertDeployPath('dev', deployDir);

  assert.equal(resolved, deployDir);
});

test('assertDeployPath throws for missing directory', () => {
  assert.throws(
    () => assertDeployPath('dev', path.join(tempRoot, 'missing-deploy-dir')),
    /deploy path not found/
  );
});
