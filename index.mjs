import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
  loadStatus, saveStatus, markRequested, markStarted, markDone, markFailed, updateStatus,
  setRuntimeState, getRuntimeState,
} from './status.mjs';

const PORT = Number(process.env.ORCHESTRATOR_PORT || 4011);
const SECRET = process.env.ASTRO_BUILD_TRIGGER_SECRET || '';
const ALLOW_MANUAL_TRIGGER = process.env.ORCHESTRATOR_ALLOW_MANUAL_TRIGGER !== '0';
const MAX_BACKUPS = Number(process.env.MAX_BACKUPS || 12);

const SOURCE_ROOT = process.env.ASTRO_SITE_ROOT || '/astro-site';
const WORKDIR = process.env.ASTRO_BUILD_WORKDIR || SOURCE_ROOT;
const STAGING_WORKDIR = process.env.ASTRO_STAGING_SITE_ROOT || '';
const SCRIPT_ROOT = process.env.ORCHESTRATOR_SCRIPT_ROOT || '/orchestrator/scripts';
const ARCHIVE_DIR = process.env.ASTRO_BUILD_ARCHIVE_DIR
  ? path.resolve(process.env.ASTRO_BUILD_ARCHIVE_DIR)
  : path.resolve(WORKDIR, 'build-archives');


const REQUIRED_ENV = [
  'ASTRO_BUILD_TRIGGER_SECRET',
  'ASTRO_SITE_ROOT',
  'ASTRO_BUILD_WORKDIR',
]
const DEPLOY_SCRIPT = path.join(SCRIPT_ROOT, 'deploy.sh');
const REQUIRED_PATHS = [
  SOURCE_ROOT,
  WORKDIR,
  SCRIPT_ROOT,
  DEPLOY_SCRIPT,
]

const TARGETS = {
  production: process.env.PRODUCTION_BUILD_PATH || '',
  preview: process.env.PREVIEW_BUILD_PATH || '',
};

const PRODUCTION_HOST = (process.env.PRODUCTION_HOST || '').replace(/\/$/, '');
const PREVIEW_HOST = (process.env.PREVIEW_HOST || '').replace(/\/$/, '');
const SMOKE_HTTP_TIMEOUT_MS = Number(process.env.ORCHESTRATOR_SMOKE_HTTP_TIMEOUT_MS || 10000);

assertRequiredEnvVars(REQUIRED_ENV);

assertRequiredPaths(REQUIRED_PATHS);

function assertRequiredEnvVars(varNames) {
  const missing = varNames.filter((name) => !String(process.env[name] || '').trim());
  if (missing.length > 0) {
    console.error(`[startup] FATAL: missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
}

function assertRequiredPaths(pathsToCheck) {
  const missing = pathsToCheck.filter((targetPath) => !fs.existsSync(targetPath));
  if (missing.length > 0) {
    console.error(`[startup] FATAL: missing required paths: ${missing.join(', ')}`);
    process.exit(1);
  }
}

const PUSH_EXCLUDE = new Set(['node_modules', '.astro', 'dist', 'build-archives', '.git', '.env', 'abcnorio-webcomponents']);
const BUILD_SYNC_EXCLUDE = new Set(['node_modules', '.astro', 'dist', 'build-archives', '.git', 'abcnorio-webcomponents']);

async function prepareBuildWorkdir(src, dest) {
  await fs.promises.mkdir(dest, { recursive: true });
  await fs.promises.cp(src, dest, {
    recursive: true,
    force: true,
    filter: (sourcePath) => !BUILD_SYNC_EXCLUDE.has(path.basename(sourcePath)),
  });
  await syncDelete(src, dest, BUILD_SYNC_EXCLUDE);
}

async function syncDelete(src, dest, excludes = PUSH_EXCLUDE) {
  let destEntries;
  try {
    destEntries = await fs.promises.readdir(dest, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of destEntries) {
    if (excludes.has(entry.name)) continue;
    const destPath = path.join(dest, entry.name);
    const srcPath = path.join(src, entry.name);
    const srcExists = await fs.promises.access(srcPath).then(() => true).catch(() => false);
    if (!srcExists) {
      await fs.promises.rm(destPath, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      await syncDelete(srcPath, destPath);
    }
  }
}

// Resolve git tag to commit SHA in SOURCE_ROOT (site-dev)
async function resolveGitTag(tag) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['rev-list', '-n', '1', tag], {
      cwd: SOURCE_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Failed to resolve tag ${tag}: ${stderr.trim()}`));
      }
    });
    proc.on('error', (err) => {
      reject(new Error(`git process error: ${err.message}`));
    });
  });
}

// Export specific git commit tree to target directory via git archive
async function exportGitCommit(commitSha, targetDir) {
  return new Promise((resolve, reject) => {
    // Use tar format to preserve file permissions and symlinks
    const tarProc = spawn('git', ['archive', '--format=tar', commitSha], {
      cwd: SOURCE_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    
    // Extract tar stream directly to target directory
    const tarPath = spawn('tar', ['-xf', '-', '-C', targetDir], {
      stdio: [tarProc.stdout, 'pipe', 'pipe'],
    });
    
    let tarErr = '';
    let extractErr = '';
    tarProc.stderr.on('data', (d) => { tarErr += d.toString(); });
    tarProc.on('error', (err) => {
      tarProc.kill();
      reject(new Error(`git archive error: ${err.message}`));
    });
    
    tarPath.stderr.on('data', (d) => { extractErr += d.toString(); });
    tarPath.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar extract failed: ${extractErr.trim() || 'unknown error'}`));
      }
    });
    tarPath.on('error', (err) => {
      reject(new Error(`tar error: ${err.message}`));
    });
  });
}

// Run npm install in a directory
async function npmInstall(dir) {
  return new Promise((resolve, reject) => {
    const proc = spawn('npm', ['install', '--package-lock=false'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`npm install failed: ${stderr.trim() || stdout.trim() || 'unknown error'}`));
      }
    });
    proc.on('error', (err) => {
      reject(new Error(`npm process error: ${err.message}`));
    });
  });
}

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
  '/dev-tools/push-to-staging': (body = {}) => ({
    key: 'push',
    label: 'push-to-staging',
    requiresStaging: true,
    run: async () => {
      const version = String(body.version || '').trim();
      const sentinelPath = path.join(STAGING_WORKDIR, '.push-in-progress');
      
      try { fs.writeFileSync(sentinelPath, ''); } catch { }
      try {
        let commitSha;
        
        // If version specified, resolve git tag; otherwise use working tree
        if (version) {
          const tag = `staging-v${version}`;
          console.log(`[push-to-staging] resolving tag ${tag}`);
          commitSha = await resolveGitTag(tag);
          console.log(`[push-to-staging] tag ${tag} → ${commitSha}`);
          
          // Clear staging workdir completely for clean export
          await fs.promises.rm(STAGING_WORKDIR, { recursive: true, force: true });
          await fs.promises.mkdir(STAGING_WORKDIR, { recursive: true });
          
          // Export exact commit tree to staging via git archive
          console.log(`[push-to-staging] exporting commit ${commitSha} to ${STAGING_WORKDIR}`);
          await exportGitCommit(commitSha, STAGING_WORKDIR);
        } else {
          // No version specified; copy from current working tree
          console.log(`[push-to-staging] copying from working tree (no version specified)`);
          await fs.promises.cp(SOURCE_ROOT, STAGING_WORKDIR, {
            recursive: true,
            force: true,
            filter: (src) => !PUSH_EXCLUDE.has(path.basename(src)),
          });
          await syncDelete(SOURCE_ROOT, STAGING_WORKDIR);
        }

        // Patch package.json to use local webcomponents (not GitHub)
        const stagingPkgPath = path.join(STAGING_WORKDIR, 'package.json');
        const stagingPkg = JSON.parse(await fs.promises.readFile(stagingPkgPath, 'utf8'));
        const webcompDep = stagingPkg.dependencies?.['abcnorio-webcomponents'];
        
        if (webcompDep && (webcompDep.startsWith('file:') || webcompDep.startsWith('github:'))) {
          stagingPkg.dependencies['abcnorio-webcomponents'] = 'file:../../abcnorio-webcomponents';
          await fs.promises.writeFile(stagingPkgPath, JSON.stringify(stagingPkg, null, 2) + '\n', 'utf8');
          console.log(`[push-to-staging] patched webcomponents to local file: path`);
        }

        // Clean node_modules and lock file to ensure fresh install
        console.log(`[push-to-staging] cleaning node_modules and lockfile`);
        await fs.promises.rm(path.join(STAGING_WORKDIR, 'node_modules'), { recursive: true, force: true });
        await fs.promises.rm(path.join(STAGING_WORKDIR, 'package-lock.json'), { force: true });

        // Install dependencies
        console.log(`[push-to-staging] running npm install`);
        await npmInstall(STAGING_WORKDIR);
        console.log(`[push-to-staging] npm install completed`);

        // Clear Vite cache for clean rebuild
        await fs.promises.rm(path.join(STAGING_WORKDIR, 'node_modules', '.vite'), { recursive: true, force: true });
        
        // Restart astro-staging container to pick up new code and deps
        console.log(`[push-to-staging] restarting astro-staging container`);
        await runCommand('docker', ['compose', 'restart', 'astro-staging']);
        console.log(`[push-to-staging] astro-staging restarted`);
        
        return version ? `Code pushed to staging from approved tag staging-v${version}.` : 'Code pushed to staging from working tree.';
      } finally {
        try { fs.unlinkSync(sentinelPath); } catch { }
      }
    },
  }),
};

if (!SECRET) {
  console.error('[startup] FATAL: ASTRO_BUILD_TRIGGER_SECRET is not set — refusing to start');
  process.exit(1);
}

if (!Object.values(TARGETS).some(Boolean)) {
  console.error('[startup] FATAL: no deploy targets configured (set PRODUCTION_BUILD_PATH or PREVIEW_BUILD_PATH)');
  process.exit(1);
}

async function runSmokeChecks(target, deployPath) {
  const start = Date.now();
  const checks = [];

  function check(name, severity, passed, message) {
    checks.push({ name, severity, status: passed ? 'passed' : 'failed', message });
  }

  // Filesystem: client build exists and is non-empty (required for all targets)
  const clientPath = path.join(deployPath, 'client');
  const clientExists = fs.existsSync(clientPath);
  const clientNonEmpty = clientExists && fs.readdirSync(clientPath).some(e => e !== '.' && e !== '..');
  check('client_build_exists', 'required', clientNonEmpty,
    clientNonEmpty ? 'client/ present' : clientExists ? 'client/ empty' : `client/ missing at ${clientPath}`);

  // Production-only: SSR runtime structure
  if (target === 'production') {
    const ssrServer = path.join(deployPath, '.ssr', 'server');
    const ssrExists = fs.existsSync(ssrServer);
    const ssrNonEmpty = ssrExists && fs.readdirSync(ssrServer).length > 0;
    check('ssr_runtime_exists', 'required', ssrNonEmpty,
      ssrNonEmpty ? '.ssr/server/ present' : ssrExists ? '.ssr/server/ empty' : '.ssr/server/ missing');
  }

  // HTTP probes
  async function probe(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), SMOKE_HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
      return { ok: res.ok, code: res.status };
    } catch (e) {
      return { ok: false, code: 0, error: e.message };
    } finally {
      clearTimeout(t);
    }
  }

  if (target === 'production') {
    if (!PRODUCTION_HOST) {
      check('http_home_200', 'required', false, 'PRODUCTION_HOST not set');
    } else {
      const r = await probe(`${PRODUCTION_HOST}/`);
      check('http_home_200', 'required', r.ok,
        r.ok ? `GET / → ${r.code}` : `GET / → ${r.code}${r.error ? ` (${r.error})` : ''}`);
    }
  }

  if (target === 'preview') {
    if (!PREVIEW_HOST) {
      checks.push({ name: 'http_preview_home_200', severity: 'optional', status: 'skipped', message: 'PREVIEW_HOST not set' });
    } else {
      const r = await probe(`${PREVIEW_HOST}/`);
      check('http_preview_home_200', 'optional', r.ok,
        r.ok ? `GET / → ${r.code}` : `GET / → ${r.code}${r.error ? ` (${r.error})` : ''}`);
    }
  }

  const requiredFailed = checks.filter(c => c.severity === 'required' && c.status === 'failed').length;
  const optionalFailed = checks.filter(c => c.severity === 'optional' && c.status === 'failed').length;
  return {
    passed: requiredFailed === 0,
    requiredFailed,
    optionalFailed,
    checks,
    durationMs: Date.now() - start,
  };
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

  await prepareBuildWorkdir(SOURCE_ROOT, WORKDIR);

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
  cleanupOldArchives(target, MAX_BACKUPS);
  updateStatus('backup', target, { archivePath });
  updateStatus('deploy', target, { deployBuildPath: resolvedDeployPath });

  const smokeResults = await runSmokeChecks(target, resolvedDeployPath);
  updateStatus('smoke', target, smokeResults);
  if (!smokeResults.passed) {
    const failedNames = smokeResults.checks
      .filter(c => c.severity === 'required' && c.status === 'failed')
      .map(c => c.name).join(', ');
    const message = `smoke checks failed: ${failedNames}`;
    setRuntimeState({ status: 'failed', target, started: startedAt, finished: Date.now(), exitCode: 0, message });
    markFailed(target, message);
    console.log(`[worker] ${target} smoke failed: ${failedNames}`);
    throw new Error(message);
  }
  console.log(`[worker] ${target} smoke checks passed (${smokeResults.durationMs}ms)`);
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

  if (req.method === 'GET' && req.url === '/dev-tools/status') {
    return respond(200, devToolsState);
  }

  if (req.method === 'POST' && DEV_OPS[req.url]) {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      // If body read fails, continue with empty body for backwards compat
      console.log(`[dev-tools] ignoring body read error: ${err.message}`);
    }
    
    // DEV_OPS entries can be operation objects or factory functions
    const opDefOrFactory = DEV_OPS[req.url];
    const op = typeof opDefOrFactory === 'function' ? opDefOrFactory(body) : opDefOrFactory;
    
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

/* handle container shutdown, stop accepting requests, wait for jobs to finish, reset status. */
async function shutdown(signal) {
  console.log(`[deploy-orchestrator] ${signal} received, shutting down...`);
  server.close(() => console.log('[deploy-orchestrator] HTTP server closed.'));
  const { status } = getQueueStatus();
  if (status !== 'idle') {
    console.log('[deploy-orchestrator] build in progress, waiting for queue to drain...');
    await new Promise(resolve => {
      const check = setInterval(() => {
        if (getQueueStatus().status === 'idle') {
          clearInterval(check);
          resolve();
        }
      }, 500);
    });
    console.log('[deploy-orchestrator] queue drained.');
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
