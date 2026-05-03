import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { enqueue, getQueueStatus } from './queue.mjs';
import { devToolsState, startDevOp, copyMediaFiles, dumpDatabase, uploads, db } from './dev-tools.mjs';
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
const ALLOW_MANUAL_TRIGGER = process.env.ORCHESTRATOR_ALLOW_MANUAL_TRIGGER !== '0';
const MAX_BACKUPS = Number(process.env.MAX_BACKUPS || 12);

const WORKDIR = process.env.ASTRO_SITE_ROOT || '/astro-site';
const STAGING_WORKDIR = process.env.ASTRO_STAGING_SITE_ROOT || '';
const SCRIPT_ROOT = process.env.ORCHESTRATOR_SCRIPT_ROOT || '/orchestrator/scripts';
const ARCHIVE_DIR = path.resolve(WORKDIR, 'build-archives');

const PUSH_EXCLUDE = new Set(['node_modules', '.astro', 'dist', 'build-archives', '.git']);

const DEV_OPS = {
  '/dev-tools/copy-media-to-staging': {
    key: 'copyMediaToStagingFromDev',
    label: 'copy-media-to-staging',
    run: () => copyMediaFiles(uploads.dev, uploads.staging).then(() => 'Media copied to staging.'),
  },
  '/dev-tools/copy-media-to-dev': {
    key: 'copyMediaFromStagingToDev',
    label: 'copy-media-to-dev',
    run: () => copyMediaFiles(uploads.staging, uploads.dev).then(() => 'Media copied to dev.'),
  },
  '/dev-tools/pull-from-dev': {
    key: 'pullDBFromDevToStaging',
    label: 'pull-from-dev',
    requiresDb: true,
    run: async () => {
      await copyMediaFiles(uploads.dev, uploads.staging);
      await dumpDatabase(db.dev, db.staging);
      return 'Dev data pulled to staging.';
    },
  },
  '/dev-tools/pull-from-staging': {
    key: 'pullFromStagingToDev',
    label: 'pull-from-staging',
    requiresDb: true,
    run: async () => {
      await copyMediaFiles(uploads.staging, uploads.dev);
      await dumpDatabase(db.staging, db.dev);
      return 'Staging data pulled to dev.';
    },
  },
  '/dev-tools/push-to-staging': {
    key: 'push',
    label: 'push-to-staging',
    requiresStaging: true,
    run: async () => {
      const sentinelPath = path.join(STAGING_WORKDIR, '.push-in-progress');
      try { fs.writeFileSync(sentinelPath, ''); } catch {}
      try {
        await fs.promises.cp(WORKDIR, STAGING_WORKDIR, {
          recursive: true,
          force: true,
          filter: (src) => !PUSH_EXCLUDE.has(path.basename(src)),
        });
      } finally {
        try { fs.unlinkSync(sentinelPath); } catch {}
      }
      return 'Code pushed to staging.';
    },
  },
};

const DEPLOY_SCRIPT = path.join(SCRIPT_ROOT, 'deploy.sh');
const TARGETS = {
  production: process.env.PRODUCTION_BUILD_PATH || '',
  preview: process.env.PREVIEW_BUILD_PATH || '',
};

if (!SECRET) {
  console.error('[startup] FATAL: ASTRO_BUILD_TRIGGER_SECRET is not set — refusing to start');
  process.exit(1);
}

if (!Object.values(TARGETS).some(Boolean)) {
  console.error('[startup] FATAL: no deploy targets configured (set PRODUCTION_BUILD_PATH or PREVIEW_BUILD_PATH)');
  process.exit(1);
}

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

async function buildJob(target, scope) {
  console.log(`[worker] starting job for target=${target} scope=${scope}`);

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
}

function enqueueTarget(target, source = 'manual', scope = 'full') {
  const normalizedScope = normalizeScope(scope);
  const result = enqueue(target, source, normalizedScope, (t, _s, sc) => buildJob(t, sc));
  if (result.accepted) {
    console.log(`[enqueue] trigger accepted for ${target} (source=${source}, scope=${normalizedScope})`);
    markRequested(target);
  }
  return result;
}

const server = http.createServer(async (req, res) => {
  const respond = (code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  if (req.method === 'GET' && req.url === '/health') {
    return respond(200, { status: 'ok' });
  }

  if (!SECRET || getAuthToken(req) !== SECRET) {
    return respond(401, { error: 'unauthorized' });
  }

  if (req.method === 'GET' && req.url === '/status') {
    return respond(200, getRuntimeState());
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

    const result = enqueueTarget(target, source, scope);
    if (!result.accepted) {
      return respond(409, { error: 'build already queued' });
    }
    return respond(202, { status: 'queued', target, source, scope });
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
    return respond(200, devToolsState);
  }

  if (req.method === 'POST' && DEV_OPS[req.url]) {
    const op = DEV_OPS[req.url];
    if (op.requiresStaging && !STAGING_WORKDIR) {
      return respond(500, { error: 'ASTRO_STAGING_SITE_ROOT is not configured' });
    }
    if (op.requiresDb && (!db.dev.name || !db.staging.name)) {
      return respond(500, { error: 'DB env vars not configured (DEV_DB_NAME / STAGING_DB_NAME)' });
    }
    const started = startDevOp(op.key, op.label, op.run);
    return respond(started ? 202 : 409, started ? { status: 'running' } : { error: 'already in progress' });
  }

  respond(404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  saveStatus(loadStatus());
  console.log(`[deploy-orchestrator] listening on :${PORT}`);
});
