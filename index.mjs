import http from 'node:http';
import path from 'node:path';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { getAuthToken, readJsonBody } from './http.mjs';
import { listArchivesForTarget, runCommand, assertDeployPath, cleanupOldArchives } from './files.mjs';
import {
  loadStatus, saveStatus, markRequested, markStarted, markDone, markFailed, updateStatus,
} from './status.mjs';

const PORT = Number(process.env.ORCHESTRATOR_PORT || 4011);
const SECRET = process.env.ASTRO_BUILD_TRIGGER_SECRET || '';
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const QUEUE_NAME = process.env.BUILD_QUEUE_NAME || 'astro-build';
const DEBOUNCE_SECONDS = Number(process.env.BUILD_DEBOUNCE_SECONDS || 120);
const SAVE_TRIGGER_ENABLED = process.env.WP_SAVE_TRIGGER_QUEUE_ENABLED === '1';
const MAX_BACKUPS = Number(process.env.MAX_BACKUPS || 12);

const DEBOUNCE_MS = Math.max(0, DEBOUNCE_SECONDS) * 1000;
const WORKDIR = process.env.ASTRO_SITE_ROOT || '/astro-site';
const SCRIPT_ROOT = process.env.ORCHESTRATOR_SCRIPT_ROOT || '/orchestrator/scripts';
const ARCHIVE_DIR = path.resolve(WORKDIR, 'build-archives');
const FOLLOWUP_KEY_PREFIX = 'build:astro:followup';

const DEPLOY_SCRIPT = path.join(SCRIPT_ROOT, 'deploy.sh');
const TARGETS = {
  dev: process.env.DEV_BUILD_PATH || '',
  staging: process.env.STAGING_BUILD_PATH || '',
  production: process.env.PRODUCTION_BUILD_PATH || '',
};

/** @type {{ status: 'idle'|'running'|'done'|'failed', target: string|null, started: number|null, finished: number|null, exitCode: number|null, message: string|null }} */
let state = {
  status: 'idle',
  target: null,
  started: null,
  finished: null,
  exitCode: null,
  message: null,
};

const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(QUEUE_NAME, { connection: redis });

function followupKey(target) {
  return `${FOLLOWUP_KEY_PREFIX}:${target}`;
}

async function enqueueTarget(target, source = 'manual') {
  const jobId = `deploy-${target}`;
  const existing = await queue.getJob(jobId);

  if (state.status === 'running' && state.target === target) {
    console.log(`[enqueue] ${target} already running, queuing followup`);
    await redis.set(followupKey(target), '1');
    markRequested(target);
    return { accepted: true, followup: true };
  }

  if (existing) {
    const existingState = await existing.getState();
    console.log(`[enqueue] ${target} job exists in state: ${existingState}`);
    if (existingState === 'active') {
      await redis.set(followupKey(target), '1');
      markRequested(target);
      return { accepted: true, followup: true };
    }

    if (['waiting', 'delayed', 'prioritized', 'failed', 'completed'].includes(existingState)) {
      console.log(`[enqueue] removing existing ${existingState} job for ${target}`);
      await existing.remove();
    }
  }

  const delay = source === 'save' ? DEBOUNCE_MS : 0;
  const job = await queue.add('deploy', { target, source }, {
    jobId,
    delay,
    removeOnComplete: true,
    removeOnFail: 50,
  });

  console.log(`[enqueue] added job ${jobId} (source=${source}, delay=${delay}ms)`);
  markRequested(target);

  return { accepted: true, followup: false };
}

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { target } = job.data;

    console.log(`[worker] received job ${job.id} for target=${target}`);

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
    const exitCode = await runCommand('bash', [DEPLOY_SCRIPT, target]);
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

    const fk = followupKey(target);
    const needsFollowup = (await redis.get(fk)) === '1';
    if (needsFollowup) {
      console.log(`[worker] queueing followup job for ${target}`);
      await redis.del(fk);
      await queue.add('deploy', { target, source: 'followup' }, {
        jobId: `deploy_${target}`,
        delay: DEBOUNCE_MS,
        removeOnComplete: true,
        removeOnFail: 50,
      });
    }
  },
  {
    connection: redis,
    concurrency: 1,
  }
);

worker.on('failed', async (job, error) => {
  const target = job?.data?.target || state.target;
  console.log(`[worker:failed] job ${job?.id} target=${target}: ${error?.message}`);
  const fk = target ? followupKey(target) : '';
  if (fk) {
    await redis.del(fk);
  }

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

    if (!TARGETS[target]) {
      return respond(400, { error: 'invalid target', valid: Object.keys(TARGETS) });
    }

    if (source === 'save' && !SAVE_TRIGGER_ENABLED) {
      return respond(202, { status: 'ignored', reason: 'save trigger disabled', target });
    }

    if (source === 'save' && target === 'production') {
      return respond(403, { error: 'production save-trigger is disabled' });
    }

    try {
      const result = await enqueueTarget(target, source);
      return respond(202, { status: result.followup ? 'queued_followup' : 'queued', target, source });
    } catch (error) {
      return respond(500, { error: 'trigger failed', message: error instanceof Error ? error.message : 'unknown error' });
    }
  }

  respond(404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  saveStatus(loadStatus());
  console.log(`[deploy-orchestrator] listening on :${PORT}`);
  console.log(`[deploy-orchestrator] queue=${QUEUE_NAME} redis=${REDIS_URL}`);
});
