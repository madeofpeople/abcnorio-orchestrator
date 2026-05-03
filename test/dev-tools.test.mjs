import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'abcnorio-dev-tools-test-'));
process.env.STAGING_UPLOADS_DIR = path.join(tempRoot, 'staging-uploads');
process.env.DEV_UPLOADS_DIR = path.join(tempRoot, 'dev-uploads');
fs.mkdirSync(process.env.STAGING_UPLOADS_DIR, { recursive: true });
fs.mkdirSync(process.env.DEV_UPLOADS_DIR, { recursive: true });

const { copyMediaFiles, startDevOp, dumpDatabase, devToolsState } = await import('../dev-tools.mjs');

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

// --- dumpDatabase (error paths only — requires no live DB) ---

test('dumpDatabase rejects with descriptive error when host is unreachable', async () => {
  const src = { host: 'nonexistent-db-host-for-testing', name: 'testdb', user: 'nobody', password: 'x' };
  const dest = { host: 'nonexistent-db-host-for-testing', name: 'testdb', user: 'nobody', password: 'x' };

  await assert.rejects(
    () => dumpDatabase(src, dest),
    (err) => {
      assert.match(err.message, /mysqldump/);
      return true;
    }
  );
});
