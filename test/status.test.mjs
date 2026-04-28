import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'abcnorio-status-test-'));
process.env.ASTRO_SITE_ROOT = tempRoot;

const archiveDir = path.join(tempRoot, 'build-archives');
fs.mkdirSync(archiveDir, { recursive: true });

const {
  dirFingerprint,
  readPreviewCandidate,
  writePreviewCandidate,
  clearPreviewCandidate,
  removeBackupFromStatus,
  loadStatus,
  recordBackup,
} = await import('../status.mjs');

const { saveStatus } = await import('../status.mjs');

// --- dirFingerprint ---

test('dirFingerprint returns stable hex string for same directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'world');
  const h1 = dirFingerprint(dir);
  const h2 = dirFingerprint(dir);
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test('dirFingerprint changes when file content changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  const h1 = dirFingerprint(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'goodbye');
  const h2 = dirFingerprint(dir);
  assert.notEqual(h1, h2);
});

test('dirFingerprint changes when a file is added', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  const h1 = dirFingerprint(dir);
  fs.writeFileSync(path.join(dir, 'b.txt'), 'extra');
  const h2 = dirFingerprint(dir);
  assert.notEqual(h1, h2);
});

// --- preview candidate meta ---

test('readPreviewCandidate returns null when no meta file exists', () => {
  clearPreviewCandidate();
  const result = readPreviewCandidate();
  assert.equal(result, null);
});

test('writePreviewCandidate / readPreviewCandidate round-trips correctly', () => {
  clearPreviewCandidate();
  const fakeArchive = path.join(archiveDir, 'abcnorio-astro-production-20260427-120000.zip');
  const fingerprint = 'abc123';
  writePreviewCandidate(fakeArchive, fingerprint);
  const candidate = readPreviewCandidate();
  assert.equal(candidate.archivePath, fakeArchive);
  assert.equal(candidate.fingerprint, fingerprint);
});

test('clearPreviewCandidate removes meta file', () => {
  writePreviewCandidate('/some/archive.zip', 'abc123');
  clearPreviewCandidate();
  assert.equal(readPreviewCandidate(), null);
});

test('clearPreviewCandidate is idempotent when file not present', () => {
  clearPreviewCandidate();
  assert.doesNotThrow(() => clearPreviewCandidate());
});

// --- removeBackupFromStatus ---

test('removeBackupFromStatus removes named backup from list', () => {
  const archivePath1 = path.join(archiveDir, 'abcnorio-astro-production-20260427-120000.zip');
  const archivePath2 = path.join(archiveDir, 'abcnorio-astro-production-20260427-130000.zip');
  fs.writeFileSync(archivePath1, 'x');
  fs.writeFileSync(archivePath2, 'x');

  const s1 = loadStatus();
  recordBackup(s1, 'production', archivePath1);
  recordBackup(s1, 'production', archivePath2);
  saveStatus(s1);

  removeBackupFromStatus('production', path.basename(archivePath1));
  const status = loadStatus();
  const backups = status?.envs?.production?.backups ?? [];
  assert.ok(!backups.some((b) => b.name === path.basename(archivePath1)));
  assert.ok(backups.some((b) => b.name === path.basename(archivePath2)));
});

test('removeBackupFromStatus updates latestBackup when removed entry was latest', () => {
  clearPreviewCandidate();
  const archivePath1 = path.join(archiveDir, 'abcnorio-astro-staging-20260427-120000.zip');
  const archivePath2 = path.join(archiveDir, 'abcnorio-astro-staging-20260427-130000.zip');
  fs.writeFileSync(archivePath1, 'x');
  fs.writeFileSync(archivePath2, 'x');

  const s1 = loadStatus();
  recordBackup(s1, 'staging', archivePath1);
  recordBackup(s1, 'staging', archivePath2);
  saveStatus(s1);

  const statusBefore = loadStatus();
  const latestBefore = statusBefore?.envs?.staging?.latestBackup?.name;

  removeBackupFromStatus('staging', latestBefore);
  const statusAfter = loadStatus();
  assert.notEqual(statusAfter?.envs?.staging?.latestBackup?.name, latestBefore);
});
