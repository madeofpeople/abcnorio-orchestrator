import http from 'node:http';
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
  loadStatus, saveStatus, markRequested, markStarted, markDone, markFailed, updateStatus,
} from './status.mjs';

const PORT = Number(process.env.ORCHESTRATOR_PORT || 4011);
const SECRET = process.env.ASTRO_BUILD_TRIGGER_SECRET || '';
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const QUEUE_NAME = process.env.BUILD_QUEUE_NAME || 'astro-build';
const ALLOW_MANUAL_TRIGGER = process.env.ORCHESTRATOR_ALLOW_MANUAL_TRIGGER !== '0';
const MAX_BACKUPS = Number(process.env.MAX_BACKUPS || 12);

const WORKDIR = process.env.ASTRO_SITE_ROOT || '/astro-site';
const SCRIPT_ROOT = process.env.ORCHESTRATOR_SCRIPT_ROOT || '/orchestrator/scripts';
const ARCHIVE_DIR = path.resolve(WORKDIR, 'build-archives');

const DEPLOY_SCRIPT = path.join(SCRIPT_ROOT, 'deploy.sh');
const TARGETS = {
  dev: process.env.DEV_BUILD_PATH || '',
  staging: process.env.STAGING_BUILD_PATH || '',
  production: process.env.PRODUCTION_BUILD_PATH || '',
};

if (!SECRET) {
  console.error('[startup] FATAL: ASTRO_BUILD_TRIGGER_SECRET is not set — refusing to start');
  process.exit(1);
}

if (!Object.values(TARGETS).some(Boolean)) {
  console.error('[startup] FATAL: no deploy targets configured (set DEV_BUILD_PATH, STAGING_BUILD_PATH, or PRODUCTION_BUILD_PATH)');
  process.exit(1);
}

/** @type {{ status: 'idle'|'running'|'done'|'failed', target: string|null, started: number|null, finished: number|null, exitCode: number|null, message: string|null }} */
let state = {
  status: 'idle',
  target: null,
  started: null,
  finished: null,
  exitCode: null,
  message: null,
};

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
      keepLastIfActive: true,
    },
    removeOnComplete: true,
    removeOnFail: 50,
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

    state = {
      status: 'running',
      target,
      started: Date.now(),
      finished: null,
      exitCode: null,
      message: null,
    };
    markStarted(target);
    console.log(`[worker] ${target} marked as running, executing ${DEPLOY_SCRIPT}`);

    const archiveBefore = new Set(listArchivesForTarget(target));
    const exitCode = await runCommand('bash', [DEPLOY_SCRIPT, target, scope]);
    console.log(`[worker] ${target} script exited with code ${exitCode}`);

    if (exitCode !== 0) {
      state = {
        status: 'failed',
        target,
        started: state.started,
        finished: Date.now(),
        exitCode,
        message: `script failed with exit ${exitCode}`,
      };
      console.log(`[worker] ${target} script failed: ${state.message}`);
      throw new Error(state.message);
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
    cleanupOldArchives(target, MAX_BACKUPS);
    updateStatus('backup', target, { archivePath });
    updateStatus('deploy', target, { deployBuildPath: resolvedDeployPath });

    state = {
      status: 'done',
      target,
      started: state.started,
      finished: Date.now(),
      exitCode: 0,
      message: null,
    };
    markDone(target);
    console.log(`[worker] ${target} deployment completed successfully`);
  },
  {
    connection: redis,
    concurrency: 1,
  }
);

worker.on('failed', async (job, error) => {
  const target = job?.data?.target || state.target;
  console.log(`[worker:failed] job ${job?.id} target=${target}: ${error?.message}`);

  if (state.status !== 'failed') {
    state = {
      ...state,
      status: 'failed',
      finished: Date.now(),
      exitCode: state.exitCode ?? 1,
      message: error?.message || 'job failed',
    };
  }

  if (target) {
    markFailed(target, error?.message || 'job failed');
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
    return respond(200, state);
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

  respond(404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  saveStatus(loadStatus());
  console.log(`[deploy-orchestrator] listening on :${PORT}`);
  console.log(`[deploy-orchestrator] queue=${QUEUE_NAME} redis=${REDIS_URL}`);
});
