import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'abcnorio-orchestrator-test-'));
process.env.ASTRO_SITE_ROOT = tempRoot;
process.env.ASTRO_BUILD_ARCHIVE_DIR = path.join(tempRoot, 'build-archives');
delete process.env.ASTRO_BUILD_STATIC_ARCHIVE_DIR;

const {
  assertDeployPath,
  resolveArchiveForTarget,
  listArchivesForTarget,
  restoreArchiveToTarget,
} = await import('../files.mjs');

const archiveDir = path.join(tempRoot, 'build-archives', 'static-backup');

function resetArchiveDir() {
  fs.mkdirSync(archiveDir, { recursive: true });
  for (const name of fs.readdirSync(archiveDir)) {
    fs.rmSync(path.join(archiveDir, name), { recursive: true, force: true });
  }
}

test('listArchivesForTarget only returns matching target zip archives', () => {
  resetArchiveDir();

  fs.writeFileSync(path.join(archiveDir, 'abcnorio-astro-production-20260427-1200.zip'), 'x');
  fs.writeFileSync(path.join(archiveDir, 'abcnorio-astro-preview-20260427-1201.zip'), 'x');
  fs.writeFileSync(path.join(archiveDir, 'abcnorio-astro-production-20260427-1200.txt'), 'x');

  const result = listArchivesForTarget('production');

  assert.equal(result.length, 1);
  assert.equal(result[0], 'abcnorio-astro-production-20260427-1200.zip');
});

test('resolveArchiveForTarget accepts valid archive in archive dir', () => {
  resetArchiveDir();

  const fileName = 'abcnorio-astro-production-20260427-1200.zip';
  const archivePath = path.join(archiveDir, fileName);
  fs.writeFileSync(archivePath, 'x');

  const resolved = resolveArchiveForTarget('production', fileName);

  assert.equal(resolved, archivePath);
});

test('resolveArchiveForTarget rejects invalid prefix', () => {
  resetArchiveDir();

  fs.writeFileSync(path.join(archiveDir, 'abcnorio-astro-preview-20260427-1200.zip'), 'x');

  assert.throws(
    () => resolveArchiveForTarget('production', 'abcnorio-astro-preview-20260427-1200.zip'),
    /invalid archive/
  );
});

test('resolveArchiveForTarget rejects traversal-like filenames', () => {
  resetArchiveDir();

  assert.throws(
    () => resolveArchiveForTarget('production', 'abcnorio-astro-production-../bad.zip'),
    /invalid archive/
  );

  assert.throws(
    () => resolveArchiveForTarget('production', '../abcnorio-astro-production-20260427-1200.zip'),
    /invalid archive/
  );
});

test('resolveArchiveForTarget rejects missing file', () => {
  resetArchiveDir();

  assert.throws(
    () => resolveArchiveForTarget('production', 'abcnorio-astro-production-20260427-1200.zip'),
    /archive not found/
  );
});

test('assertDeployPath returns path for existing directory', () => {
  const deployDir = path.join(tempRoot, 'deploy-production');
  fs.mkdirSync(deployDir, { recursive: true });

  const resolved = assertDeployPath('production', deployDir);

  assert.equal(resolved, deployDir);
});

test('assertDeployPath throws for missing directory', () => {
  assert.throws(
    () => assertDeployPath('production', path.join(tempRoot, 'missing-deploy-dir')),
    /deploy path not found/
  );
});

test('restoreArchiveToTarget leaves live files untouched when beforeSwap throws', async () => {
  const base = fs.mkdtempSync(path.join(tempRoot, 'restore-'));
  const live = path.join(base, 'prod');
  fs.mkdirSync(path.join(live, 'client'), { recursive: true });
  fs.writeFileSync(path.join(live, 'client', 'index.html'), 'live');

  const staged = path.join(base, 'stage', 'prod');
  fs.mkdirSync(path.join(staged, 'client'), { recursive: true });
  fs.writeFileSync(path.join(staged, 'client', 'index.html'), 'new');
  const zip = path.join(base, 'prod.zip');
  const { execFileSync } = await import('node:child_process');
  execFileSync('zip', ['-qr', zip, 'prod'], { cwd: path.join(base, 'stage') });

  await assert.rejects(
    restoreArchiveToTarget('preview', zip, live, () => { throw new Error('leak'); }),
    /leak/,
  );
  assert.equal(fs.readFileSync(path.join(live, 'client', 'index.html'), 'utf8'), 'live');

  await restoreArchiveToTarget('preview', zip, live, () => {});
  assert.equal(fs.readFileSync(path.join(live, 'client', 'index.html'), 'utf8'), 'new');
});
