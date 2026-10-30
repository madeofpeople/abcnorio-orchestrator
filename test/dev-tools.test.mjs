import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'abcnorio-dev-tools-test-'));
process.env.STAGING_UPLOADS_DIR = path.join(tempRoot, 'staging-uploads');
process.env.DEV_UPLOADS_DIR = path.join(tempRoot, 'dev-uploads');
process.env.PRODUCTION_UPLOADS_PATH = path.join(tempRoot, 'production-uploads');
process.env.ASTRO_BUILD_DATABASE_ARCHIVE_DIR = path.join(tempRoot, 'database-backups');
process.env.MAX_DATABASE_BACKUPS = '2';
fs.mkdirSync(process.env.STAGING_UPLOADS_DIR, { recursive: true });
fs.mkdirSync(process.env.DEV_UPLOADS_DIR, { recursive: true });
fs.mkdirSync(process.env.PRODUCTION_UPLOADS_PATH, { recursive: true });

const {
  copyMediaFiles,
  syncGeneratedImageDerivatives,
  startDevOp,
  dumpDatabase,
  copyDatabase,
  createDatabaseBackupArchive,
  listDatabaseBackups,
  resolveDatabaseBackupArchive,
  devToolsState,
} = await import('../dev-tools.mjs');

function resetState(key) {
  devToolsState[key] = { status: 'idle', started: null, finished: null, message: null };
}

// --- copyMediaFiles ---

test('copyMediaFiles copies files to dest', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-src-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dest-'));
  fs.writeFileSync(path.join(src, 'image.jpg'), 'data');

  await copyMediaFiles(src, dest);

  assert.ok(fs.existsSync(path.join(dest, 'image.jpg')));
  assert.equal(fs.readFileSync(path.join(dest, 'image.jpg'), 'utf8'), 'data');
});

test('copyMediaFiles does not overwrite existing dest files (force: false)', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-src-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dest-'));
  fs.writeFileSync(path.join(src, 'image.jpg'), 'new');
  fs.writeFileSync(path.join(dest, 'image.jpg'), 'original');

  await copyMediaFiles(src, dest);

  assert.equal(fs.readFileSync(path.join(dest, 'image.jpg'), 'utf8'), 'original');
});

test('copyMediaFiles copies nested directories', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-src-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dest-'));
  fs.mkdirSync(path.join(src, '2026', '04'), { recursive: true });
  fs.writeFileSync(path.join(src, '2026', '04', 'photo.jpg'), 'img');

  await copyMediaFiles(src, dest);

  assert.ok(fs.existsSync(path.join(dest, '2026', '04', 'photo.jpg')));
});

test('syncGeneratedImageDerivatives overwrites generated sizes but preserves originals', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-src-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-dest-'));
  fs.mkdirSync(path.join(src, '2026', '04'), { recursive: true });
  fs.mkdirSync(path.join(dest, '2026', '04'), { recursive: true });
  fs.writeFileSync(path.join(src, '2026', '04', 'poster-353x457.webp'), 'new derivative');
  fs.writeFileSync(path.join(src, '2026', '04', 'poster.webp'), 'staging original');
  fs.writeFileSync(path.join(dest, '2026', '04', 'poster-353x457.webp'), 'old derivative');
  fs.writeFileSync(path.join(dest, '2026', '04', 'poster.webp'), 'production original');

  const result = await syncGeneratedImageDerivatives(src, dest);

  assert.deepEqual(result, {
    copiedFiles: 1,
    copiedBytes: Buffer.byteLength('new derivative'),
  });
  assert.equal(fs.readFileSync(path.join(dest, '2026', '04', 'poster-353x457.webp'), 'utf8'), 'new derivative');
  assert.equal(fs.readFileSync(path.join(dest, '2026', '04', 'poster.webp'), 'utf8'), 'production original');
});

// --- startDevOp ---

test('startDevOp transitions idle → running → done', async () => {
  resetState('push');

  const started = startDevOp('push', 'test-push', () => Promise.resolve('push complete'));

  assert.ok(started);
  assert.equal(devToolsState.push.status, 'running');
  assert.ok(devToolsState.push.started !== null);

  await new Promise((r) => setTimeout(r, 50));

  assert.equal(devToolsState.push.status, 'done');
  assert.equal(devToolsState.push.message, 'push complete');
  assert.ok(devToolsState.push.finished !== null);
});

test('startDevOp transitions idle → running → failed on rejection', async () => {
  resetState('copyMediaFromStagingToDev');

  startDevOp('copyMediaFromStagingToDev', 'test-copy', () => Promise.reject(new Error('disk full')));

  await new Promise((r) => setTimeout(r, 50));

  assert.equal(devToolsState.copyMediaFromStagingToDev.status, 'failed');
  assert.equal(devToolsState.copyMediaFromStagingToDev.message, 'disk full');
  assert.ok(devToolsState.copyMediaFromStagingToDev.finished !== null);
});

test('startDevOp returns false and does not restart when already running', async () => {
  resetState('pullFromStagingToDev');
  devToolsState.pullFromStagingToDev.status = 'running';

  const started = startDevOp('pullFromStagingToDev', 'test', () => Promise.resolve('should not run'));

  assert.equal(started, false);
  assert.equal(devToolsState.pullFromStagingToDev.status, 'running');
});

test('startDevOp preserves started timestamp across async completion', async () => {
  resetState('copyMediaToStagingFromDev');

  startDevOp('copyMediaToStagingFromDev', 'test-ts', () =>
    new Promise((r) => setTimeout(() => r('ok'), 20))
  );

  const startedAt = devToolsState.copyMediaToStagingFromDev.started;
  await new Promise((r) => setTimeout(r, 80));

  assert.equal(devToolsState.copyMediaToStagingFromDev.started, startedAt);
  assert.ok(devToolsState.copyMediaToStagingFromDev.finished >= startedAt);
});

// --- dumpDatabase / copyDatabase (error paths only — requires no live DB, but needs the mysql client) ---

test('dumpDatabase fails before copying when the destination is unreachable', async () => {
  const conn = { host: 'nonexistent-db-host-for-testing', name: 'testdb', user: 'nobody', password: 'x' };

  await assert.rejects(
    () => dumpDatabase(conn, conn),
    /mysql failed: .*nonexistent-db-host-for-testing/
  );
});

test('copyDatabase reports mysqldump failure when the source is unreachable', async () => {
  const conn = { host: 'nonexistent-db-host-for-testing', name: 'testdb', user: 'nobody', password: 'x' };

  await assert.rejects(
    () => copyDatabase(conn, conn),
    /mysqldump failed: .*nonexistent-db-host-for-testing/
  );
});

test('database backups are created and retained separately for Dev and Staging', async () => {
  const archiveDir = process.env.ASTRO_BUILD_DATABASE_ARCHIVE_DIR;
  fs.mkdirSync(archiveDir, { recursive: true });
  const now = Date.now();
  for (const [env, count] of [['dev', 2], ['staging', 3]]) {
    for (let index = 0; index < count; index += 1) {
      const name = `abcnorio-database-${env}-20261012-00000${index}.sql`;
      const filePath = path.join(archiveDir, name);
      fs.writeFileSync(filePath, `old ${env} ${index}`);
      const oldTime = new Date(now - (count - index) * 60_000);
      fs.utimesSync(filePath, oldTime, oldTime);
    }
  }

  const binDir = path.join(tempRoot, 'fake-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const mysqldump = path.join(binDir, 'mysqldump');
  fs.writeFileSync(mysqldump, '#!/bin/sh\nprintf "fixture SQL\\n"\n', { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath}`;
  let backupName;
  try {
    backupName = await createDatabaseBackupArchive({
      host: 'unused',
      user: 'test',
      password: 'test',
      name: 'dev_db',
    }, 'dev');
  } finally {
    process.env.PATH = originalPath;
  }

  assert.match(backupName, /^abcnorio-database-dev-[a-zA-Z0-9_-]+\.sql$/);
  assert.equal(fs.readFileSync(path.join(archiveDir, backupName), 'utf8'), 'fixture SQL\n');
  assert.equal(listDatabaseBackups('dev').length, 2);
  assert.equal(listDatabaseBackups('staging').length, 2);
  assert.equal(fs.readdirSync(archiveDir).filter((name) => name.startsWith('abcnorio-database-staging-')).length, 3);
  assert.equal(resolveDatabaseBackupArchive(backupName, 'dev'), path.join(archiveDir, backupName));
  assert.throws(
    () => resolveDatabaseBackupArchive(backupName, 'staging'),
    /invalid archive/
  );
});
