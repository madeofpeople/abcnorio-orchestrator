import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { getAuthToken, readJsonBody } from './http.mjs';
import {
  listArchivesForTarget,
  runCommand,
  assertDeployPath,
  cleanupOldArchives,
  resolveArchiveForTarget,
  restoreArchiveToTarget,
} from './files.mjs';
import {
  loadStatus, saveStatus, markRequested, markStarted, markDone, markFailed, updateStatus, removeBackupFromStatus,
  dirFingerprint, readPreviewCandidate, writePreviewCandidate, clearPreviewCandidate,
  setRuntimeState, getRuntimeState,
} from './status.mjs';

const PORT = Number(process.env.ORCHESTRATOR_PORT || 4011);
const SECRET = process.env.ASTRO_BUILD_TRIGGER_SECRET || '';
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const QUEUE_NAME = process.env.BUILD_QUEUE_NAME || 'astro-build';
const ALLOW_MANUAL_TRIGGER = process.env.ORCHESTRATOR_ALLOW_MANUAL_TRIGGER !== '0';
const MAX_BACKUPS = Number(process.env.MAX_BACKUPS || 12);
const WORKER_LOCK_MS = Number(process.env.ORCHESTRATOR_WORKER_LOCK_MS || 300000);
const WORKER_STALLED_INTERVAL_MS = Number(process.env.ORCHESTRATOR_WORKER_STALLED_INTERVAL_MS || 30000);

const WORKDIR = process.env.ASTRO_SITE_ROOT || '/astro-site';
const STAGING_WORKDIR = process.env.ASTRO_STAGING_SITE_ROOT || '';
const SCRIPT_ROOT = process.env.ORCHESTRATOR_SCRIPT_ROOT || '/orchestrator/scripts';
const ARCHIVE_DIR = path.resolve(WORKDIR, 'build-archives');

const PUSH_EXCLUDE = new Set(['node_modules', '.astro', 'dist', 'build-archives', '.git']);
let pushState = { status: 'idle', started: null, finished: null, message: null };

const DEPLOY_SCRIPT = path.join(SCRIPT_ROOT, 'deploy.sh');
const TARGETS = {
  dev: process.env.DEV_BUILD_PATH || '',
  staging: process.env.STAGING_BUILD_PATH || '',
  production: process.env.PRODUCTION_BUILD_PATH || '',
  preview: process.env.PREVIEW_BUILD_PATH || '',
};

if (!SECRET) {
  console.error('[startup] FATAL: ASTRO_BUILD_TRIGGER_SECRET is not set — refusing to start');
  process.exit(1);
}

if (!Object.values(TARGETS).some(Boolean)) {
  console.error('[startup] FATAL: no deploy targets configured (set DEV_BUILD_PATH, STAGING_BUILD_PATH, or PRODUCTION_BUILD_PATH)');
  process.exit(1);
}

const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
redis.on('error', () => {});

try {
  await redis.connect();
} catch (err) {
  console.error(`[startup] FATAL: Redis unreachable at ${REDIS_URL} — ${err.message}`);
  process.exit(1);
}

redis.removeAllListeners('error');

const queue = new Queue(QUEUE_NAME, { connection: redis });

function normalizeScope(scope) {
  const candidate = String(scope || 'full').trim().toLowerCase();
  if (candidate === 'full') {
    return 'full';
  }

  if (/^[a-z0-9][a-z0-9_-]*$/.test(candidate)) {
    return candidate;
  }

  return 'full';
}

async function enqueueTarget(target, source = 'manual', scope = 'full') {
  const normalizedScope = normalizeScope(scope);
  const dedupId = `deploy-${target}`;

  await queue.add('deploy', { target, source, scope: normalizedScope }, {
    deduplication: {
      id: dedupId,
    },
    // Keep recent jobs to avoid finish-time key races under bursty triggers.
    removeOnComplete: 100,
    removeOnFail: 100,
  });

  console.log(`[enqueue] trigger accepted for ${target} (source=${source}, scope=${normalizedScope}, dedup=${dedupId})`);
  markRequested(target);

  return { accepted: true };
}

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { target } = job.data;
    const scope = normalizeScope(job.data.scope);

    console.log(`[worker] received job ${job.id} for target=${target} scope=${scope}`);

    if (!TARGETS[target]) {
      throw new Error(`invalid target: ${target}`);
    }

    const deployBuildPath = TARGETS[target];
    const resolvedDeployPath = assertDeployPath(target, deployBuildPath);

    const startedAt = Date.now();
    setRuntimeState({
      status: 'running',
      target,
      started: startedAt,
      finished: null,
      exitCode: null,
      message: null,
    });
    markStarted(target);

    // --- Preview candidate reuse: if production is triggered and preview is unchanged, restore from archive ---
    if (target === 'production') {
      const candidate = readPreviewCandidate();
      const previewPath = TARGETS['preview'];
      if (candidate && previewPath && fs.existsSync(previewPath) && fs.existsSync(candidate.archivePath)) {
        const currentFingerprint = dirFingerprint(previewPath);
        if (currentFingerprint === candidate.fingerprint) {
          console.log(`[worker] production: reusing preview candidate archive: ${path.basename(candidate.archivePath)}`);
          await restoreArchiveToTarget('production', candidate.archivePath, deployBuildPath);
          const promotedName = path.basename(candidate.archivePath).replace('-preview-', '-production-');
          const promotedPath = path.join(ARCHIVE_DIR, promotedName);
          fs.renameSync(candidate.archivePath, promotedPath);
          cleanupOldArchives('production', MAX_BACKUPS);
          updateStatus('backup', 'production', { archivePath: promotedPath });
          clearPreviewCandidate();
          updateStatus('deploy', target, { deployBuildPath: resolvedDeployPath });
          setRuntimeState({ status: 'done', target, started: startedAt, finished: Date.now(), exitCode: 0, message: null });
          markDone(target);
          console.log(`[worker] production deployment completed (from preview candidate)`);
          return;
        }
        console.log(`[worker] production: preview candidate fingerprint mismatch — doing full build`);
      }
    }

    console.log(`[worker] ${target} executing ${DEPLOY_SCRIPT}`);
    const archiveBefore = new Set(listArchivesForTarget(target));
    const exitCode = await runCommand('bash', [DEPLOY_SCRIPT, target, scope]);
    console.log(`[worker] ${target} script exited with code ${exitCode}`);

    if (exitCode !== 0) {
      const message = `script failed with exit ${exitCode}`;
      setRuntimeState({
        status: 'failed',
        target,
        started: startedAt,
        finished: Date.now(),
        exitCode,
        message,
      });
      markFailed(target, message);
      console.log(`[worker] ${target} script failed: ${message}`);
      throw new Error(message);
    }

    const archiveAfter = listArchivesForTarget(target);
    const createdArchive = archiveAfter.find((name) => !archiveBefore.has(name));
    if (!createdArchive) {
      const message = `backup contract violation: no new archive created for target=${target}`;
      console.warn(`[worker] ${message}`);
      throw new Error(message);
    }

    const archivePath = path.join(ARCHIVE_DIR, createdArchive);
    console.log(`[worker] ${target} found archive: ${path.basename(archivePath)}`);
    cleanupOldArchives(target, target === 'preview' ? 1 : MAX_BACKUPS);
    updateStatus('backup', target, { archivePath });
    updateStatus('deploy', target, { deployBuildPath: resolvedDeployPath });

    // --- After a preview build: store archive as production candidate ---
    if (target === 'preview') {
      const previewPath = TARGETS['preview'];
      if (previewPath && fs.existsSync(previewPath)) {
        const fingerprint = dirFingerprint(previewPath);
        writePreviewCandidate(archivePath, fingerprint);
        console.log(`[worker] preview candidate saved: ${createdArchive}`);
      }
    }

    setRuntimeState({
      status: 'done',
      target,
      started: startedAt,
      finished: Date.now(),
      exitCode: 0,
      message: null,
    });
    markDone(target);
    console.log(`[worker] ${target} deployment completed successfully`);
  },
  {
    connection: redis,
    concurrency: 1,
    lockDuration: WORKER_LOCK_MS,
    stalledInterval: WORKER_STALLED_INTERVAL_MS,
  }
);

worker.on('failed', async (job, error) => {
  const runtime = getRuntimeState();
  const target = job?.data?.target || runtime.target;
  console.log(`[worker:failed] job ${job?.id} target=${target}: ${error?.message}`);

  // Runtime status is already set in the worker body for script failures.
  // Only update here for unexpected BullMQ-level failures (stalled, lock lost, etc.).
  if (runtime.status !== 'failed') {
    setRuntimeState({
      ...runtime,
      status: 'failed',
      finished: Date.now(),
      exitCode: runtime.exitCode ?? 1,
      message: error?.message || 'job failed',
    });
    if (target) {
      markFailed(target, error?.message || 'job failed');
    }
  }
});

worker.on('completed', (job) => {
  console.log(`[worker:completed] job ${job.id} target=${job.data.target}`);
});

worker.on('error', (error) => {
  console.log(`[worker:error] ${error.message}`);
});

console.log('[worker] initialized and ready');

const server = http.createServer(async (req, res) => {
  const respond = (code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  if (!SECRET || getAuthToken(req) !== SECRET) {
    return respond(401, { error: 'unauthorized' });
  }

  if (req.method === 'GET' && req.url === '/status') {
    return respond(200, getRuntimeState());
  }

  if (req.method === 'GET' && req.url === '/health') {
    return respond(200, { status: 'ok' });
  }

  if (req.method === 'POST' && req.url === '/trigger') {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      return respond(400, { error: 'invalid json' });
    }

    const target = String(body.target || '').trim();
    const source = String(body.source || 'manual').trim();
    const scope = normalizeScope(String(body.scope || 'full').trim());

    if (!TARGETS[target]) {
      return respond(400, { error: 'invalid target', valid: Object.keys(TARGETS) });
    }

    if (source === 'manual' && !ALLOW_MANUAL_TRIGGER) {
      return respond(403, { error: 'manual trigger is disabled' });
    }

    if (source === 'save' && target === 'production') {
      return respond(403, { error: 'production save-trigger is disabled' });
    }

    try {
      await enqueueTarget(target, source, scope);
      return respond(202, {
        status: 'queued',
        target,
        source,
        scope,
      });
    } catch (error) {
      return respond(500, { error: 'trigger failed', message: error instanceof Error ? error.message : 'unknown error' });
    }
  }

  if (req.method === 'POST' && req.url === '/restore') {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      return respond(400, { error: 'invalid json' });
    }

    const target = String(body.target || '').trim();
    const file = String(body.file || '').trim();

    if (!TARGETS[target]) {
      return respond(400, { error: 'invalid target', valid: Object.keys(TARGETS) });
    }

    try {
      const archivePath = resolveArchiveForTarget(target, file);
      const deployBuildPath = TARGETS[target];
      const restoredPath = await restoreArchiveToTarget(target, archivePath, deployBuildPath);
      updateStatus('deploy', target, { deployBuildPath: restoredPath });
      return respond(200, {
        status: 'restored',
        target,
        file,
      });
    } catch (error) {
      return respond(400, {
        error: 'restore failed',
        message: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }

  if (req.method === 'POST' && req.url === '/delete-backup') {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      return respond(400, { error: 'invalid json' });
    }

    const target = String(body.target || '').trim();
    const file = String(body.file || '').trim();

    if (!TARGETS[target]) {
      return respond(400, { error: 'invalid target', valid: Object.keys(TARGETS) });
    }

    try {
      const archivePath = resolveArchiveForTarget(target, file);
      fs.unlinkSync(archivePath);
      removeBackupFromStatus(target, file);
      console.log(`[delete-backup] deleted ${file} for target=${target}`);
      return respond(200, { status: 'deleted', target, file });
    } catch (error) {
      return respond(400, {
        error: 'delete failed',
        message: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }

  if (req.method === 'GET' && req.url === '/dev-tools/status') {
    return respond(200, pushState);
  }

  if (req.method === 'POST' && req.url === '/dev-tools/push-to-staging') {
    if (!STAGING_WORKDIR) {
      return respond(500, { error: 'ASTRO_STAGING_SITE_ROOT is not configured' });
    }

    if (pushState.status === 'running') {
      return respond(409, { error: 'push already in progress' });
    }

    const startedAt = Date.now();
    pushState = { status: 'running', started: startedAt, finished: null, message: null };
    console.log(`[push-to-staging] started: ${WORKDIR} \u2192 ${STAGING_WORKDIR}`);

    const sentinelPath = path.join(STAGING_WORKDIR, '.push-in-progress');
    try { fs.writeFileSync(sentinelPath, ''); } catch {}

    fs.promises.cp(WORKDIR, STAGING_WORKDIR, {
      recursive: true,
      force: true,
      filter: (src) => !PUSH_EXCLUDE.has(path.basename(src)),
    }).then(() => {
      try { fs.unlinkSync(sentinelPath); } catch {}
      pushState = { status: 'done', started: startedAt, finished: Date.now(), message: 'Code pushed to staging.' };
      console.log('[push-to-staging] complete');
    }).catch((err) => {
      try { fs.unlinkSync(sentinelPath); } catch {}
      pushState = { status: 'failed', started: startedAt, finished: Date.now(), message: err.message };
      console.error(`[push-to-staging] failed: ${err.message}`);
    });

    return respond(202, { status: 'running' });
  }

  respond(404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  saveStatus(loadStatus());
  console.log(`[deploy-orchestrator] listening on :${PORT}`);
  console.log(`[deploy-orchestrator] queue=${QUEUE_NAME} redis=${REDIS_URL}`);
});
