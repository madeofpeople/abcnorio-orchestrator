import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { z } from 'zod';
import { enqueue, getQueueStatus } from './queue.mjs';
import { devToolsState, startDevOp, copyMediaFiles, createMediaBackupArchive, createDatabaseBackupArchive, listDatabaseBackups, resolveDatabaseBackupArchive, dumpDatabase, uploads, db, assertUploadsContract } from './dev-tools.mjs';
import {
  listArchivesForTarget,
  runCommand,
  assertDeployPath,
  cleanupOldArchives,
  resolveArchiveForTargetByReleaseId,
  extractReleaseIdFromArchiveName,
  restoreArchiveToTarget,
} from './files.mjs';
import {
  loadStatus, saveStatus, markRequested, markStarted, markDone, markFailed, updateStatus,
  setRuntimeState, getRuntimeState, recordStagingDeployment, markStagingDeploymentVerified,
  readWebcomponentsShaFromLock, assertInstalledWebcomponentsSha, assertStagingSourceSha,
} from './status.mjs';

const PORT = Number(process.env.ORCHESTRATOR_PORT || 4011);
const SECRET = process.env.ASTRO_BUILD_TRIGGER_SECRET || '';
const ALLOW_MANUAL_TRIGGER = process.env.ORCHESTRATOR_ALLOW_MANUAL_TRIGGER !== '0';
const MAX_BACKUPS = Number(process.env.MAX_BACKUPS || 12);
const STAGING_SUCCESS_RELEASES_TO_KEEP = Number(process.env.STAGING_SUCCESS_RELEASES_TO_KEEP || 2);
const STAGING_FAILED_RELEASES_TO_KEEP = Number(process.env.STAGING_FAILED_RELEASES_TO_KEEP || 1);

const SOURCE_ROOT = process.env.ASTRO_SITE_ROOT || '/astro-site';
const SOURCE_GIT_ROOT = process.env.ASTRO_SITE_GIT_ROOT || SOURCE_ROOT;
const SOURCE_GIT_SUBDIR = (process.env.ASTRO_SITE_GIT_SUBDIR || '').replace(/^\/+|\/+$/g, '');
const STAGING_HEALTH_URL = String(process.env.STAGING_HEALTH_URL || '').trim();
const STAGING_FRONTEND_HEALTH_URL = String(process.env.STAGING_FRONTEND_HEALTH_URL || '').trim();
const STAGING_PLUGIN_VERSION_URL = String(process.env.STAGING_PLUGIN_VERSION_URL || '').trim();
const WORKDIR = process.env.ASTRO_BUILD_WORKDIR || SOURCE_ROOT;
const STAGING_WORKDIR = process.env.ASTRO_STAGING_SITE_ROOT || '';
const STAGING_RELEASES_ROOT = process.env.ASTRO_STAGING_RELEASES_ROOT
  ? path.resolve(process.env.ASTRO_STAGING_RELEASES_ROOT)
  : path.join(STAGING_WORKDIR, 'releases');
const SCRIPT_ROOT = process.env.ORCHESTRATOR_SCRIPT_ROOT || '/orchestrator/scripts';
const BASE_ARCHIVE_DIR = process.env.ASTRO_BUILD_ARCHIVE_DIR
  ? path.resolve(process.env.ASTRO_BUILD_ARCHIVE_DIR)
  : path.resolve(WORKDIR, 'build-archives');
const STATIC_ARCHIVE_DIR = process.env.ASTRO_BUILD_STATIC_ARCHIVE_DIR
  ? path.resolve(process.env.ASTRO_BUILD_STATIC_ARCHIVE_DIR)
  : path.resolve(BASE_ARCHIVE_DIR, 'static-backup');
const MEDIA_ARCHIVE_DIR = process.env.ASTRO_BUILD_MEDIA_ARCHIVE_DIR
  ? path.resolve(process.env.ASTRO_BUILD_MEDIA_ARCHIVE_DIR)
  : path.resolve(BASE_ARCHIVE_DIR, 'media');
const STAGING_LAST_FAILED_FILE = '.last-failed-release';
let productionWriteInProgress = false;

function listMediaBackups(target) {
  if (!fs.existsSync(MEDIA_ARCHIVE_DIR)) {
    return [];
  }

  const prefix = `abcnorio-media-${target}-`;
  return fs.readdirSync(MEDIA_ARCHIVE_DIR)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.zip'))
    .map((name) => {
      const fullPath = path.join(MEDIA_ARCHIVE_DIR, name);
      return {
        name,
        mtime: fs.statSync(fullPath).mtimeMs,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function resolveMediaBackupArchive(target, requestedName) {
  const name = String(requestedName || '').trim();
  const prefix = `abcnorio-media-${target}-`;

  if (!name || !name.startsWith(prefix) || !name.endsWith('.zip')) {
    throw new Error('invalid archive');
  }

  if (name.includes('/') || name.includes('\\')) {
    throw new Error('invalid archive');
  }

  const archivePath = path.resolve(MEDIA_ARCHIVE_DIR, name);
  if (!archivePath.startsWith(`${MEDIA_ARCHIVE_DIR}${path.sep}`)) {
    throw new Error('invalid archive');
  }

  if (!fs.existsSync(archivePath) || !fs.statSync(archivePath).isFile()) {
    throw new Error('archive not found');
  }

  return archivePath;
}


const REQUIRED_ENV = [
  'ASTRO_BUILD_TRIGGER_SECRET',
  'ASTRO_SITE_ROOT',
  'ASTRO_BUILD_WORKDIR',
]
const DEPLOY_SCRIPT = path.join(SCRIPT_ROOT, 'deploy.sh');
const REQUIRED_PATHS = [
  SOURCE_ROOT,
  SOURCE_GIT_ROOT,
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
const MEDIA_SYNC_TARGETS = ['dev', 'staging'];

assertRequiredEnvVars(REQUIRED_ENV);

assertRequiredPaths(REQUIRED_PATHS);

assertUploadsContract();

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

async function clearDirectoryContents(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
  const entries = await fs.promises.readdir(dir);
  await Promise.all(entries.map((entry) => fs.promises.rm(path.join(dir, entry), { recursive: true, force: true })));
}

async function clearDirectoryContentsExcept(dir, keepEntries = []) {
  const keep = new Set(keepEntries);
  await fs.promises.mkdir(dir, { recursive: true });
  const entries = await fs.promises.readdir(dir);
  await Promise.all(entries
    .filter((entry) => !keep.has(entry))
    .map((entry) => fs.promises.rm(path.join(dir, entry), { recursive: true, force: true })));
}

async function copyDirectoryContents(srcDir, destDir) {
  await fs.promises.mkdir(destDir, { recursive: true });
  const entries = await fs.promises.readdir(srcDir, { withFileTypes: true });
  await Promise.all(entries.map((entry) => {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    return fs.promises.cp(srcPath, destPath, { recursive: true, force: true });
  }));
}

async function pruneStagingReleaseDirs(releasesRoot, successfulTag) {
  await fs.promises.mkdir(releasesRoot, { recursive: true });
  const entries = await fs.promises.readdir(releasesRoot, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

  const lastFailedPath = path.join(releasesRoot, STAGING_LAST_FAILED_FILE);
  let failedTag = '';
  if (fs.existsSync(lastFailedPath)) {
    failedTag = (await fs.promises.readFile(lastFailedPath, 'utf8')).trim();
  }

  const stagingReleaseDirs = dirs.filter((name) =>
    name.startsWith('staging-release-') || name.startsWith('staging-deploy-'));
  const successful = [];
  for (const releaseId of stagingReleaseDirs) {
    if (failedTag && releaseId === failedTag) {
      continue;
    }
    const fullPath = path.join(releasesRoot, releaseId);
    const stat = await fs.promises.stat(fullPath);
    successful.push({ releaseId, mtime: stat.mtimeMs });
  }

  successful.sort((a, b) => b.mtime - a.mtime);
  const keepSuccessful = new Set(successful.slice(0, STAGING_SUCCESS_RELEASES_TO_KEEP).map((item) => item.releaseId));
  if (successfulTag) {
    keepSuccessful.add(successfulTag);
  }

  const failedToKeep = new Set();
  if (failedTag && STAGING_FAILED_RELEASES_TO_KEEP > 0) {
    failedToKeep.add(failedTag);
  }

  for (const releaseId of stagingReleaseDirs) {
    if (keepSuccessful.has(releaseId) || failedToKeep.has(releaseId)) {
      continue;
    }
    await fs.promises.rm(path.join(releasesRoot, releaseId), { recursive: true, force: true });
  }
}

// Resolve git ref (branch, tag, or commit-ish) to commit SHA in SOURCE_GIT_ROOT.
async function resolveGitRef(ref, repositoryRoot = SOURCE_GIT_ROOT) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
      cwd: repositoryRoot,
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
        reject(new Error(`Failed to resolve git ref ${ref}: ${stderr.trim()}`));
      }
    });
    proc.on('error', (err) => {
      reject(new Error(`git process error: ${err.message}`));
    });
  });
}

async function resolveLatestTagByPrefix(prefix) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', [
      'for-each-ref',
      '--sort=-creatordate',
      '--format=%(refname:strip=2)',
      `refs/tags/${prefix}*`,
    ], {
      cwd: SOURCE_GIT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to list tags for prefix ${prefix}: ${stderr.trim()}`));
        return;
      }

      const tags = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      if (tags.length === 0) {
        reject(new Error(`No tags found for prefix ${prefix}`));
        return;
      }

      resolve(tags[0]);
    });
    proc.on('error', (err) => {
      reject(new Error(`git process error: ${err.message}`));
    });
  });
}

async function resolveGitRefIfExists(ref) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: SOURCE_GIT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      if (!stdout.trim() && !stderr.trim()) {
        resolve(null);
        return;
      }

      reject(new Error(`Failed to resolve git ref ${ref}: ${stderr.trim()}`));
    });
    proc.on('error', (err) => {
      reject(new Error(`git process error: ${err.message}`));
    });
  });
}

function npmSpawnEnv() {
  const env = { ...process.env };

  // Keep npm memory bounded inside constrained containers to reduce OOM kills.
  // Keep the cap modest enough for the orchestrator container while leaving room for
  // the package graph resolution itself to complete.
  if (!env.NODE_OPTIONS || !env.NODE_OPTIONS.includes('--max-old-space-size=')) {
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ''}--max-old-space-size=256`;
  }

  env.npm_config_audit = env.npm_config_audit || 'false';
  env.npm_config_fund = env.npm_config_fund || 'false';
  env.npm_config_progress = env.npm_config_progress || 'false';
  env.npm_config_loglevel = env.npm_config_loglevel || 'warn';
  env.npm_config_jobs = env.npm_config_jobs || '1';
  env.npm_config_cache = env.npm_config_cache || '/tmp/npm-cache';

  return env;
}

async function runGitCommand(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd: SOURCE_GIT_ROOT,
      stdio: 'inherit',
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`git ${args.join(' ')} failed with exit code ${code ?? 1}`));
    });

    proc.on('error', (err) => {
      reject(new Error(`git process error: ${err.message}`));
    });
  });
}

async function tagProductionDeploy(commitSha, deployedAt) {
  const deployDate = new Date(deployedAt).toISOString().slice(0, 10);
  const shortSha = commitSha.slice(0, 7);
  const tagName = `production-deploy-${deployDate}-${shortSha}`;

  const existingCommitSha = await resolveGitRefIfExists(tagName);
  if (existingCommitSha && existingCommitSha !== commitSha) {
    throw new Error(`production tag ${tagName} already points to ${existingCommitSha}, expected ${commitSha}`);
  }

  if (!existingCommitSha) {
    await runGitCommand(['tag', '-a', tagName, commitSha, '-m', `Production deploy ${deployDate} ${shortSha}`]);
  }

  await runGitCommand(['push', 'origin', tagName]);

  return tagName;
}

// Export specific git commit tree to target directory via git archive
async function exportGitCommit(commitSha, targetDir, gitSubdir = SOURCE_GIT_SUBDIR) {
  const archivePath = path.join(targetDir, '.tmp-git-export.tar');
  fs.rmSync(archivePath, { force: true });

  return new Promise((resolve, reject) => {
    const archiveArgs = ['archive', '--format=tar', '--output', archivePath, commitSha];
    if (gitSubdir) {
      archiveArgs.push('--', gitSubdir);
    }

    const gitProc = spawn('git', archiveArgs, {
      cwd: SOURCE_GIT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let gitErr = '';
    gitProc.stderr.on('data', (d) => { gitErr += d.toString(); });
    gitProc.on('error', (err) => {
      reject(new Error(`git archive error: ${err.message}`));
    });

    gitProc.on('close', (code) => {
      if (code !== 0) {
        fs.rmSync(archivePath, { force: true });
        reject(new Error(`git archive failed: ${gitErr.trim() || 'unknown error'}`));
        return;
      }

      const stripComponents = gitSubdir ? gitSubdir.split('/').filter(Boolean).length : 0;
      const extractArgs = ['-xf', archivePath, '-C', targetDir];
      if (stripComponents > 0) {
        extractArgs.push(`--strip-components=${stripComponents}`);
      }

      const tarProc = spawn('tar', extractArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let extractErr = '';
      tarProc.stderr.on('data', (d) => { extractErr += d.toString(); });
      tarProc.on('error', (err) => {
        fs.rmSync(archivePath, { force: true });
        reject(new Error(`tar error: ${err.message}`));
      });

      tarProc.on('close', (tarCode) => {
        fs.rmSync(archivePath, { force: true });
        if (tarCode === 0) {
          resolve();
        } else {
          reject(new Error(`tar extract failed: ${extractErr.trim() || 'unknown error'}`));
        }
      });
    });
  });
}

async function npmCi(dir) {
  return new Promise((resolve, reject) => {
    const proc = spawn('npm', ['ci'], {
      cwd: dir,
      env: npmSpawnEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    let exitCode = null;
    let exitSignal = null;
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });
    proc.on('close', () => {
      if (exitCode === 0) {
        resolve();
      } else {
        const stderrTail = stderr.trim().split('\n').slice(-30).join('\n');
        const stdoutTail = stdout.trim().split('\n').slice(-30).join('\n');
        const reason = stderrTail || stdoutTail || 'no npm output captured';
        reject(new Error(`npm ci failed (code=${String(exitCode)}, signal=${String(exitSignal)}): ${reason}`));
      }
    });
    proc.on('error', (err) => {
      reject(new Error(`npm process error: ${err.message}`));
    });
  });
}

async function npmInstallDeterministic(dir) {
  const hasLock = fs.existsSync(path.join(dir, 'package-lock.json'));
  if (!hasLock) {
    throw new Error(`npm ci requires package-lock.json in ${dir}`);
  }

  await npmCi(dir);
}

function parseJsonFile(filePath, label) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} parse failed at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${label} invalid JSON object at ${filePath}`);
  }
  return parsed;
}

function assertStagingWebcomponentsContract(stagingRoot) {
  const packageJsonPath = path.join(stagingRoot, 'package.json');
  const packageLockPath = path.join(stagingRoot, 'package-lock.json');

  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`staging package missing at ${packageJsonPath}`);
  }
  if (!fs.existsSync(packageLockPath)) {
    throw new Error(`staging lockfile missing at ${packageLockPath}`);
  }

  const pkg = parseJsonFile(packageJsonPath, 'package.json');
  if (!pkg.dependencies || typeof pkg.dependencies !== 'object') {
    throw new Error('staging package.json missing dependencies object');
  }

  const currentDep = String(pkg.dependencies['abcnorio-webcomponents'] || '').trim();
  if (!currentDep.startsWith('github:') || !currentDep.includes('#')) {
    throw new Error(`staging contract violation: abcnorio-webcomponents must be git-pinned (github:*#ref), got "${currentDep || '(empty)'}"`);
  }

  if (currentDep.includes('file:')) {
    throw new Error('staging lockfile contract violation: contains file:../../abcnorio-webcomponents');
  }

  return readWebcomponentsShaFromLock(packageLockPath);
}

function assertStagingInputs(stagingRoot, expected) {
  assertStagingSourceSha(stagingRoot, expected.sourceCommitSha);
  const installedWebcomponentsSha = assertInstalledWebcomponentsSha(stagingRoot);
  if (installedWebcomponentsSha !== expected.webcomponentsCommitSha) {
    throw new Error('staging installed webcomponents SHA does not match recorded deployment');
  }
}

async function assertReadablePath(targetPath, label) {
  let stat;
  try {
    stat = await fs.promises.stat(targetPath);
  } catch {
    throw new Error(`${label} missing at ${targetPath}`);
  }

  if (!stat.isFile()) {
    throw new Error(`${label} is not a file at ${targetPath}`);
  }
}

async function assertStagingTreeContract(stagingRoot) {
  const requiredFiles = [
    ['package.json', 'staging package'],
    ['astro.config.mjs', 'staging astro config'],
    ['src/pages/index.astro', 'staging index route'],
  ];

  await Promise.all(requiredFiles.map(([relativePath, label]) =>
    assertReadablePath(path.join(stagingRoot, relativePath), label)
  ));
}

async function assertNodeModuleResolvable(stagingRoot, moduleName) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['-e', `require.resolve(${JSON.stringify(moduleName)});`], {
      cwd: stagingRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`runtime dependency missing (${moduleName}): ${stderr.trim() || 'resolution failed'}`));
    });
    proc.on('error', (err) => {
      reject(new Error(`node process error (${moduleName}): ${err.message}`));
    });
  });
}

async function checksumFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => reject(new Error(`failed to read artifact for checksum: ${err.message}`)));
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function readStagingPluginVersion() {
  if (!STAGING_PLUGIN_VERSION_URL) {
    throw new Error('STAGING_PLUGIN_VERSION_URL is required');
  }

  const response = await fetch(STAGING_PLUGIN_VERSION_URL, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) {
    throw new Error(`staging plugin version endpoint returned HTTP ${response.status}`);
  }

  const body = await response.json();
  const version = String(body?.version || '').trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('staging plugin version endpoint returned an invalid version');
  }

  return version;
}

async function finishProductionDeploy(syncStagingUploads = false) {
  const productionUploadsPath = String(process.env.PRODUCTION_UPLOADS_PATH || '').trim();
  if (syncStagingUploads && productionUploadsPath && fs.existsSync(uploads.staging)) {
    await fs.promises.mkdir(productionUploadsPath, { recursive: true });
    await fs.promises.cp(uploads.staging, productionUploadsPath, {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
  }

  const warmCacheScript = path.join(SCRIPT_ROOT, 'warm-cache.sh');
  const warmCacheExitCode = await runCommand('bash', [warmCacheScript], process.env);
  if (warmCacheExitCode !== 0) {
    console.warn(`[production] cache warm failed with exit ${warmCacheExitCode}`);
  }
}

function getTargetEnvStatus(target) {
  const status = loadStatus();
  const envStatus = status?.envs?.[target];
  if (!envStatus || typeof envStatus !== 'object') {
    throw new Error(`missing status for target=${target}`);
  }
  return envStatus;
}

function getReleaseMetadata(target, releaseId) {
  if (!releaseId) {
    return null;
  }

  const envStatus = getTargetEnvStatus(target);
  const releases = Array.isArray(envStatus.releases) ? envStatus.releases : [];
  return releases.find((entry) => entry?.releaseId === releaseId) || null;
}

function resolveRollbackReleaseId(target) {
  const envStatus = getTargetEnvStatus(target);
  const releases = Array.isArray(envStatus.releases) ? envStatus.releases : [];
  if (releases.length < 2) {
    throw new Error(`no previous release available for rollback target=${target}`);
  }

  return String(releases[1].releaseId || '').trim();
}

async function deployReleaseArtifact(target, deployBuildPath, archivePath, sourceCommitSha = null, syncStagingUploads = false) {
  const resolvedArchivePath = path.resolve(archivePath);
  const releaseId = extractReleaseIdFromArchiveName(target, path.basename(resolvedArchivePath));
  const checksumSha256 = await checksumFileSha256(resolvedArchivePath);
  const releaseMeta = getReleaseMetadata(target, releaseId);

  if (releaseMeta?.checksumSha256 && releaseMeta.checksumSha256 !== checksumSha256) {
    throw new Error(`artifact checksum mismatch for release_id=${releaseId}`);
  }

  const restoredPath = await restoreArchiveToTarget(target, resolvedArchivePath, deployBuildPath);

  updateStatus('deploy', target, {
    deployBuildPath: restoredPath,
    releaseId,
    sourceCommitSha: sourceCommitSha || releaseMeta?.sourceCommitSha || null,
    checksumSha256,
    artifactPath: resolvedArchivePath,
  });

  const smokeResults = await runSmokeChecks(target, restoredPath);
  updateStatus('smoke', target, smokeResults);
  if (!smokeResults.passed) {
    const failedNames = smokeResults.checks
      .filter((c) => c.severity === 'required' && c.status === 'failed')
      .map((c) => c.name)
      .join(', ');
    throw new Error(`smoke checks failed after deploy release_id=${releaseId}: ${failedNames}`);
  }

  if (target === 'production') {
    await finishProductionDeploy(syncStagingUploads);
  }

  return {
    restoredPath,
    releaseId,
    checksumSha256,
  };
}

function isKnownDeployTarget(target) {
  return Boolean(TARGETS[target]);
}

function isKnownMediaTarget(target) {
  return MEDIA_SYNC_TARGETS.includes(target);
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
  '/dev-tools/backup-media-dev': {
    key: 'backupMediaDev',
    label: 'backup-media-dev',
    run: () => createMediaBackupArchive(uploads.dev, 'dev').then((name) => `Dev media backup created: ${name}`),
  },
  '/dev-tools/backup-media-staging': {
    key: 'backupMediaStaging',
    label: 'backup-media-staging',
    run: () => createMediaBackupArchive(uploads.staging, 'staging').then((name) => `Staging media backup created: ${name}`),
  },
  '/dev-tools/backup-database-staging': {
    key: 'backupDatabaseStaging',
    label: 'backup-database-staging',
    requiresDb: true,
    run: () => createDatabaseBackupArchive(db.staging).then((name) => `Staging database backup created: ${name}`),
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
  '/dev-tools/push-to-staging': () => ({
    key: 'push',
    label: 'push-to-staging',
    requiresStaging: true,
    run: async () => {
      const sentinelPath = path.join(STAGING_WORKDIR, '.push-in-progress');
      const stagingSourceRef = 'staging';
      let sourceReleaseId = '';
      let stagingPluginVersion = '';

      fs.writeFileSync(sentinelPath, '');
      try {
        console.log(`[push-to-staging] resolving ${stagingSourceRef} branch head`);
        const commitSha = await resolveGitRef(stagingSourceRef);
        stagingPluginVersion = await readStagingPluginVersion();
        const deployDate = new Date().toISOString().slice(0, 10);
        sourceReleaseId = `staging-release-${deployDate}-${commitSha.slice(0, 7)}`;
        console.log(`[push-to-staging] selected ${stagingSourceRef} → ${commitSha} (${sourceReleaseId})`);

        const releaseDir = path.join(STAGING_RELEASES_ROOT, sourceReleaseId);
        await clearDirectoryContents(releaseDir);
        console.log(`[push-to-staging] exporting commit ${commitSha} to release ${releaseDir}`);
        await exportGitCommit(commitSha, releaseDir, SOURCE_GIT_SUBDIR);

        await assertStagingTreeContract(releaseDir);
        const webcomponentsCommitSha = assertStagingWebcomponentsContract(releaseDir);

        await fs.promises.rm(path.join(releaseDir, 'node_modules'), { recursive: true, force: true });
        await npmInstallDeterministic(releaseDir);
        await assertNodeModuleResolvable(releaseDir, 'astro');
        const installedWebcomponentsSha = assertInstalledWebcomponentsSha(releaseDir);
        if (installedWebcomponentsSha !== webcomponentsCommitSha) {
          throw new Error(`installed webcomponents SHA ${installedWebcomponentsSha} does not match package-lock SHA ${webcomponentsCommitSha}`);
        }
        fs.writeFileSync(path.join(releaseDir, '.staging-provenance.json'), `${JSON.stringify({
          sourceCommitSha: commitSha,
        })}\n`);

        // Cut over active staging tree from prepared release. The release dir is
        // the canonical deterministic install and has already been validated, so
        // we avoid the extra post-copy install unless the runtime contract later
        // proves the live tree still requires it.
        await clearDirectoryContentsExcept(STAGING_WORKDIR, ['releases', '.push-in-progress']);
        await copyDirectoryContents(releaseDir, STAGING_WORKDIR);
        await assertStagingTreeContract(STAGING_WORKDIR);
        await assertNodeModuleResolvable(STAGING_WORKDIR, 'astro');
        const activeWebcomponentsSha = assertInstalledWebcomponentsSha(STAGING_WORKDIR);
        if (activeWebcomponentsSha !== webcomponentsCommitSha) {
          throw new Error(`active staging workdir webcomponents SHA ${activeWebcomponentsSha} does not match candidate SHA ${webcomponentsCommitSha}`);
        }
        const livePluginVersion = await readStagingPluginVersion();
        if (livePluginVersion !== stagingPluginVersion) {
          throw new Error(`staging plugin changed during cutover (before ${stagingPluginVersion}, after ${livePluginVersion})`);
        }
        recordStagingDeployment(commitSha, webcomponentsCommitSha, sourceReleaseId, stagingPluginVersion);

        await pruneStagingReleaseDirs(STAGING_RELEASES_ROOT, sourceReleaseId);
        await fs.promises.rm(path.join(STAGING_RELEASES_ROOT, STAGING_LAST_FAILED_FILE), { force: true });

        return `Staging release ${sourceReleaseId} prepared for commit ${commitSha} with webcomponents ${webcomponentsCommitSha} and plugin ${stagingPluginVersion}.`;
      } catch (error) {
        try {
          if (sourceReleaseId) {
            await fs.promises.mkdir(STAGING_RELEASES_ROOT, { recursive: true });
            await fs.promises.writeFile(path.join(STAGING_RELEASES_ROOT, STAGING_LAST_FAILED_FILE), `${sourceReleaseId}\n`, 'utf8');
          }
        } catch (markerError) {
          console.warn(`[push-to-staging] failed to persist last-failed marker: ${markerError instanceof Error ? markerError.message : String(markerError)}`);
        }
        throw error;
      } finally {
        try {
          fs.unlinkSync(sentinelPath);
        } catch (unlinkError) {
          console.warn(`[push-to-staging] failed to remove in-progress sentinel: ${unlinkError instanceof Error ? unlinkError.message : String(unlinkError)}`);
        }
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

  throw new Error(`invalid scope: ${scope}`);
}

function failBuildJob(target, startedAt, message, exitCode = 1) {
  setRuntimeState({
    status: 'failed',
    target,
    started: startedAt,
    finished: Date.now(),
    exitCode,
    message,
  });
  markFailed(target, message);
}

async function buildJob(target, scope, requestedCommitSha = '', promotionState = null) {
  console.log(`[worker] starting job for target=${target} scope=${scope}`);

  const deployBuildPath = TARGETS[target];
  const resolvedDeployPath = assertDeployPath(target, deployBuildPath);
  const sourceCommitSha = await resolveGitRef(requestedCommitSha || 'HEAD');

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

  if (requestedCommitSha) {
    await clearDirectoryContents(WORKDIR);
    await exportGitCommit(sourceCommitSha, WORKDIR, SOURCE_GIT_SUBDIR);
  } else {
    await prepareBuildWorkdir(SOURCE_ROOT, WORKDIR);
  }

  if (promotionState) {
    try {
      const lockedWebcomponentsSha = readWebcomponentsShaFromLock(path.join(WORKDIR, 'package-lock.json'));
      if (lockedWebcomponentsSha !== promotionState.webcomponentsCommitSha) {
        throw new Error(`production candidate lock pins webcomponents ${lockedWebcomponentsSha}, tested Staging pins ${promotionState.webcomponentsCommitSha}`);
      }
    } catch (error) {
      const message = `production candidate does not match tested Staging inputs: ${error instanceof Error ? error.message : String(error)}`;
      failBuildJob(target, startedAt, message);
      throw new Error(message);
    }
  }

  console.log(`[worker] ${target} executing ${DEPLOY_SCRIPT}`);
  const archiveBefore = new Set(listArchivesForTarget(target));
  const commandEnv = {
    ...process.env,
    SOURCE_COMMIT_SHA: sourceCommitSha,
  };
  if (promotionState) {
    commandEnv.ASTRO_DESIGN_TOKENS_DIR = path.join(
      WORKDIR,
      'node_modules/abcnorio-webcomponents/src/design-tokens',
    );
  }
  const exitCode = await runCommand('bash', [DEPLOY_SCRIPT, target, scope], commandEnv);
  console.log(`[worker] ${target} script exited with code ${exitCode}`);

  if (exitCode !== 0) {
    const message = `script failed with exit ${exitCode}`;
    failBuildJob(target, startedAt, message, exitCode);
    console.log(`[worker] ${target} script failed: ${message}`);
    throw new Error(message);
  }

  if (promotionState) {
    const installedWebcomponentsSha = assertInstalledWebcomponentsSha(WORKDIR);
    if (installedWebcomponentsSha !== promotionState.webcomponentsCommitSha) {
      const message = `production installed webcomponents ${installedWebcomponentsSha} differs from tested Staging ${promotionState.webcomponentsCommitSha}`;
      failBuildJob(target, startedAt, message);
      throw new Error(message);
    }

    const livePluginVersion = await readStagingPluginVersion();
    if (livePluginVersion !== promotionState.pluginVersion) {
      const message = `staging plugin changed during production build (tested ${promotionState.pluginVersion}, live ${livePluginVersion}); production was not updated`;
      failBuildJob(target, startedAt, message);
      throw new Error(message);
    }

  }

  const archiveAfter = listArchivesForTarget(target);
  const createdArchive = archiveAfter.find((name) => !archiveBefore.has(name));
  if (!createdArchive) {
    const message = `backup contract violation: no new archive created for target=${target}`;
    console.warn(`[worker] ${message}`);
    failBuildJob(target, startedAt, message);
    throw new Error(message);
  }

  const archivePath = path.join(STATIC_ARCHIVE_DIR, createdArchive);
  const releaseId = extractReleaseIdFromArchiveName(target, createdArchive);
  const checksumSha256 = await checksumFileSha256(archivePath);
  console.log(`[worker] ${target} found archive: ${path.basename(archivePath)}`);
  cleanupOldArchives(target, MAX_BACKUPS);
  updateStatus('backup', target, {
    archivePath,
    sourceCommitSha,
    releaseId,
    checksumSha256,
  });
  let deployedRelease;
  try {
    deployedRelease = await deployReleaseArtifact(
      target,
      resolvedDeployPath,
      archivePath,
      sourceCommitSha,
      target === 'production' && requestedCommitSha !== '',
    );
  } catch (error) {
    const message = `${target} release ${releaseId} deployment failed: ${error instanceof Error ? error.message : String(error)}`;
    failBuildJob(target, startedAt, message);
    throw error;
  }
  console.log(`[worker] ${target} deployed release_id=${deployedRelease.releaseId || 'unknown'} checksum=${deployedRelease.checksumSha256}`);
  if (target === 'production') {
    try {
      const tagName = await tagProductionDeploy(sourceCommitSha, Date.now());
      console.log(`[worker] production deploy tagged: ${tagName} @ ${sourceCommitSha}`);
    } catch (error) {
      const message = `production deployed release ${deployedRelease.releaseId}, but tagging failed: ${error instanceof Error ? error.message : String(error)}`;
      failBuildJob(target, startedAt, message);
      throw error;
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

function enqueueTarget(target, source = 'manual', scope = 'full', sourceCommitSha = '', promotionState = null) {
  const normalizedScope = normalizeScope(scope);
  const result = enqueue(target, source, normalizedScope, async (t, _s, sc) => {
    try {
      await buildJob(t, sc, sourceCommitSha, promotionState);
    } finally {
      if (source === 'staging-promotion') {
        productionWriteInProgress = false;
      }
    }
  });
  if (result.accepted) {
    console.log(`[enqueue] trigger accepted for ${target} (source=${source}, scope=${normalizedScope})`);
    markRequested(target);
  }
  return result;
}
const app = new Hono();

const TriggerBodySchema = z.object({
  target: z.string().trim().min(1),
  source: z.string().trim().default('manual'),
  scope: z.string().trim().default('full'),
});

const RestoreBodySchema = z.object({
  target: z.string().trim().min(1),
  release_id: z.string().trim().min(1).optional(),
  releaseId: z.string().trim().min(1).optional(),
});

const RollbackBodySchema = z.object({
  target: z.string().trim().min(1),
  release_id: z.string().trim().optional(),
  releaseId: z.string().trim().optional(),
});

const MediaDeleteBodySchema = z.object({
  target: z.string().trim().min(1),
  file: z.string().trim().min(1),
});

function jsonOk(c, code, data = {}) {
  return c.json({ ok: true, data }, code);
}

function jsonError(c, code, errorCode, message, details = undefined) {
  const error = {
    code: String(errorCode || 'error'),
    message: String(message || 'request failed'),
  };
  if (details !== undefined) {
    error.details = details;
  }
  return c.json({ ok: false, error }, code);
}

async function parseBody(c, schema) {
  let raw;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, response: jsonError(c, 400, 'invalid_json', 'invalid json') };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: jsonError(c, 400, 'invalid_body', 'invalid request body', parsed.error.flatten()),
    };
  }

  return { ok: true, data: parsed.data };
}

const deployArchiveForTarget = async (target, archivePath, sourceCommitSha = null) => {
  const deployBuildPath = TARGETS[target];
  return deployReleaseArtifact(target, deployBuildPath, archivePath, sourceCommitSha);
};

app.get('/health', (c) => jsonOk(c, 200, { status: 'ok' }));

app.use('*', async (c, next) => {
  const auth = c.req.header('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  if (!SECRET || token !== SECRET) {
    return jsonError(c, 401, 'unauthorized', 'unauthorized');
  }
  await next();
});

app.get('/status', (c) => jsonOk(c, 200, getRuntimeState()));

app.post('/trigger', async (c) => {
  const parsed = await parseBody(c, TriggerBodySchema);
  if (!parsed.ok) {
    return parsed.response;
  }

  const target = parsed.data.target;
  const source = parsed.data.source;
  let scope = 'full';
  try {
    scope = normalizeScope(parsed.data.scope);
  } catch (error) {
    return jsonError(c, 400, 'invalid_scope', error instanceof Error ? error.message : 'unknown scope error');
  }

  if (!isKnownDeployTarget(target)) {
    return jsonError(c, 400, 'invalid_target', 'invalid target', { valid: Object.keys(TARGETS) });
  }
  if (target === 'production') {
    return jsonError(c, 403, 'production_requires_staging_promotion', 'production builds must promote the commit currently deployed to healthy staging');
  }
  if (source === 'manual' && !ALLOW_MANUAL_TRIGGER) {
    return jsonError(c, 403, 'manual_trigger_disabled', 'manual trigger is disabled');
  }
  const result = enqueueTarget(target, source, scope);
  if (!result.accepted) {
    return jsonError(c, 409, 'build_already_queued', 'build already queued');
  }

  return jsonOk(c, 202, { status: 'queued', target, source, scope });
});

app.post('/promote-staging', async (c) => {
  if (productionWriteInProgress) {
    return jsonError(c, 409, 'production_operation_running', 'a production deploy or restore is already running');
  }

  const stagingDeployment = getTargetEnvStatus('staging').stagingDeployment;
  const sourceCommitSha = String(stagingDeployment?.sourceCommitSha || '').trim();
  const stagedWebcomponentsSha = String(stagingDeployment?.webcomponentsCommitSha || '').trim();
  const stagingReleaseId = String(stagingDeployment?.releaseId || '').trim();
  const recordedPluginVersion = String(stagingDeployment?.pluginVersion || '').trim();
  const verifiedAt = String(stagingDeployment?.verifiedAt || '').trim();

  if (!/^[a-f0-9]{40}$/i.test(sourceCommitSha)) {
    return jsonError(c, 409, 'staging_commit_unavailable', 'no valid full commit SHA is recorded for the staging deployment');
  }

  if (!recordedPluginVersion) {
    return jsonError(c, 409, 'staging_plugin_version_unavailable', 'no staging plugin version is recorded for the tested staging deployment');
  }
  if (!/^[a-f0-9]{40}$/i.test(stagedWebcomponentsSha)) {
    return jsonError(c, 409, 'staging_webcomponents_sha_unavailable', 'no valid webcomponents SHA is recorded for the staging deployment');
  }
  if (!verifiedAt) {
    return jsonError(c, 409, 'staging_not_verified', 'staging candidate has not been activated and verified');
  }
  if (devToolsState.push.status === 'running') {
    return jsonError(c, 409, 'staging_cutover_running', 'staging deployment is in progress');
  }

  const healthChecks = [
    ['CMS', STAGING_HEALTH_URL],
    ['frontend', STAGING_FRONTEND_HEALTH_URL],
  ];
  for (const [label, url] of healthChecks) {
    if (!url) {
      return jsonError(c, 503, 'staging_health_url_missing', `staging ${label} health URL is required for production promotion`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) {
        return jsonError(c, 409, 'staging_unhealthy', `staging ${label} health probe returned HTTP ${response.status}`);
      }
    } catch (error) {
      return jsonError(c, 409, 'staging_unhealthy', `staging ${label} health probe failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    const resolvedSha = await resolveGitRef(sourceCommitSha);
    if (resolvedSha !== sourceCommitSha) {
      return jsonError(c, 409, 'staging_commit_mismatch', 'recorded staging SHA did not resolve to the same commit');
    }

    assertStagingInputs(STAGING_WORKDIR, stagingDeployment);
    const livePluginVersion = await readStagingPluginVersion();
    if (livePluginVersion !== recordedPluginVersion) {
      return jsonError(c, 409, 'staging_plugin_version_changed', `staging plugin changed since frontend verification (recorded ${recordedPluginVersion}, live ${livePluginVersion}); deploy and verify staging again`);
    }

    const latestStagingDeployment = getTargetEnvStatus('staging').stagingDeployment;
    if (latestStagingDeployment?.sourceCommitSha !== sourceCommitSha
      || latestStagingDeployment?.webcomponentsCommitSha !== stagedWebcomponentsSha
      || latestStagingDeployment?.pluginVersion !== recordedPluginVersion
      || latestStagingDeployment?.verifiedAt !== verifiedAt
      || devToolsState.push.status === 'running') {
      return jsonError(c, 409, 'staging_changed_during_promotion_check', 'staging changed while promotion was being validated; retry after staging is stable');
    }

    if (productionWriteInProgress) {
      return jsonError(c, 409, 'production_operation_running', 'a production deploy or restore is already running');
    }
    productionWriteInProgress = true;
    const result = enqueueTarget('production', 'staging-promotion', 'full', sourceCommitSha, {
      pluginVersion: recordedPluginVersion,
      webcomponentsCommitSha: stagedWebcomponentsSha,
    });
    if (!result.accepted) {
      productionWriteInProgress = false;
      return jsonError(c, 409, 'build_already_queued', 'a build or promotion is already queued');
    }

    return jsonOk(c, 202, {
      status: 'queued',
      target: 'production',
      source: 'staging-promotion',
      source_commit_sha: sourceCommitSha,
      staging_release_id: stagingReleaseId,
      staging_plugin_version: livePluginVersion,
      webcomponents_commit_sha: stagedWebcomponentsSha,
    });
  } catch (error) {
    productionWriteInProgress = false;
    return jsonError(c, 409, 'staging_commit_unavailable', error instanceof Error ? error.message : String(error));
  }
});

app.post('/dev-tools/verify-staging', async (c) => {
  if (devToolsState.push.status === 'running') {
    return jsonError(c, 409, 'staging_cutover_running', 'cannot verify staging while cutover is running');
  }

  const stagingDeployment = getTargetEnvStatus('staging').stagingDeployment;
  const sourceCommitSha = String(stagingDeployment?.sourceCommitSha || '').trim();
  const webcomponentsCommitSha = String(stagingDeployment?.webcomponentsCommitSha || '').trim();
  const releaseId = String(stagingDeployment?.releaseId || '').trim();
  const pluginVersion = String(stagingDeployment?.pluginVersion || '').trim();

  if (!sourceCommitSha || !webcomponentsCommitSha || !releaseId || !pluginVersion) {
    return jsonError(c, 409, 'staging_candidate_unavailable', 'no complete prepared staging candidate is recorded');
  }

  try {
    assertStagingInputs(STAGING_WORKDIR, stagingDeployment);
    const livePluginVersion = await readStagingPluginVersion();
    if (livePluginVersion !== pluginVersion) {
      return jsonError(c, 409, 'staging_plugin_version_changed', `staging plugin version changed (prepared ${pluginVersion}, live ${livePluginVersion})`);
    }

    for (const [label, url] of [['CMS', STAGING_HEALTH_URL], ['frontend', STAGING_FRONTEND_HEALTH_URL]]) {
      if (!url) {
        return jsonError(c, 503, 'staging_health_url_missing', `staging ${label} health URL is required`);
      }
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) {
        return jsonError(c, 409, 'staging_unhealthy', `staging ${label} health probe returned HTTP ${response.status}`);
      }
    }

    const latestStagingDeployment = getTargetEnvStatus('staging').stagingDeployment;
    if (devToolsState.push.status === 'running'
      || latestStagingDeployment?.sourceCommitSha !== sourceCommitSha
      || latestStagingDeployment?.webcomponentsCommitSha !== webcomponentsCommitSha
      || latestStagingDeployment?.releaseId !== releaseId
      || latestStagingDeployment?.pluginVersion !== pluginVersion) {
      return jsonError(c, 409, 'staging_changed_during_verification', 'staging candidate changed during verification; retry after cutover is stable');
    }

    markStagingDeploymentVerified(releaseId, sourceCommitSha, webcomponentsCommitSha, pluginVersion);
    return jsonOk(c, 200, {
      status: 'verified',
      source_commit_sha: sourceCommitSha,
      webcomponents_commit_sha: webcomponentsCommitSha,
      plugin_version: pluginVersion,
      release_id: releaseId,
    });
  } catch (error) {
    return jsonError(c, 409, 'staging_verification_failed', error instanceof Error ? error.message : String(error));
  }
});

app.post('/restore', async (c) => {
  const parsed = await parseBody(c, RestoreBodySchema);
  if (!parsed.ok) {
    return parsed.response;
  }

  const target = parsed.data.target;
  const releaseId = String(parsed.data.release_id || parsed.data.releaseId || '').trim();
  if (!isKnownDeployTarget(target)) {
    return jsonError(c, 400, 'invalid_target', 'invalid target', { valid: Object.keys(TARGETS) });
  }
  if (!releaseId) {
    return jsonError(c, 400, 'missing_release_id', 'release_id is required');
  }
  if (target === 'production' && productionWriteInProgress) {
    return jsonError(c, 409, 'production_operation_running', 'a production deploy or restore is already running');
  }

  if (target === 'production') productionWriteInProgress = true;
  try {
    const archivePath = resolveArchiveForTargetByReleaseId(target, releaseId);
    const deployment = await deployArchiveForTarget(target, archivePath);
    return jsonOk(c, 200, {
      status: 'restored',
      target,
      file: path.basename(archivePath),
      release_id: deployment.releaseId,
      checksum_sha256: deployment.checksumSha256,
    });
  } catch (error) {
    return jsonError(c, 400, 'restore_failed', error instanceof Error ? error.message : 'unknown error');
  } finally {
    if (target === 'production') productionWriteInProgress = false;
  }
});

app.post('/rollback', async (c) => {
  const parsed = await parseBody(c, RollbackBodySchema);
  if (!parsed.ok) {
    return parsed.response;
  }

  const target = parsed.data.target;
  const releaseId = String(parsed.data.release_id || parsed.data.releaseId || '').trim();
  if (!isKnownDeployTarget(target)) {
    return jsonError(c, 400, 'invalid_target', 'invalid target', { valid: Object.keys(TARGETS) });
  }
  if (target === 'production' && productionWriteInProgress) {
    return jsonError(c, 409, 'production_operation_running', 'a production deploy or rollback is already running');
  }

  if (target === 'production') productionWriteInProgress = true;
  try {
    const selectedReleaseId = releaseId || resolveRollbackReleaseId(target);
    const archivePath = resolveArchiveForTargetByReleaseId(target, selectedReleaseId);
    const deployment = await deployArchiveForTarget(target, archivePath);
    return jsonOk(c, 200, {
      status: 'rolled_back',
      target,
      release_id: deployment.releaseId,
      checksum_sha256: deployment.checksumSha256,
    });
  } catch (error) {
    return jsonError(c, 400, 'rollback_failed', error instanceof Error ? error.message : 'unknown error');
  } finally {
    if (target === 'production') productionWriteInProgress = false;
  }
});

app.get('/releases', (c) => {
  const target = String(c.req.query('target') || '').trim();
  if (!isKnownDeployTarget(target)) {
    return jsonError(c, 400, 'invalid_target', 'invalid target', { valid: Object.keys(TARGETS) });
  }

  const envStatus = getTargetEnvStatus(target);
  return jsonOk(c, 200, {
    target,
    latest_release_id: envStatus.latestReleaseId || null,
    releases: Array.isArray(envStatus.releases) ? envStatus.releases : [],
  });
});

app.get('/dev-tools/status', (c) => jsonOk(c, 200, devToolsState));

app.get('/dev-tools/media-backups', (c) => {
  const target = String(c.req.query('target') || '').trim();
  if (!isKnownMediaTarget(target)) {
    return jsonError(c, 400, 'invalid_target', 'invalid target', { valid: MEDIA_SYNC_TARGETS });
  }
  return jsonOk(c, 200, {
    target,
    backups: listMediaBackups(target),
  });
});

app.get('/dev-tools/database-backups', (c) => jsonOk(c, 200, { backups: listDatabaseBackups() }));

app.get('/dev-tools/database-backups/download', (c) => {
  const file = String(c.req.query('file') || '').trim();

  try {
    const archivePath = resolveDatabaseBackupArchive(file);
    const stat = fs.statSync(archivePath);
    const stream = fs.createReadStream(archivePath);
    c.header('Content-Type', 'application/sql');
    c.header('Content-Disposition', `attachment; filename="${path.basename(archivePath)}"`);
    c.header('Content-Length', String(stat.size));
    return c.body(stream, 200);
  } catch (error) {
    return jsonError(c, 404, 'archive_not_found', error instanceof Error ? error.message : 'unknown error');
  }
});

app.post('/dev-tools/database-backups/delete', async (c) => {
  let parsed;
  try {
    parsed = await c.req.json();
  } catch {
    return jsonError(c, 400, 'invalid_json', 'invalid json');
  }

  const file = String(parsed?.file || '').trim();
  try {
    const archivePath = resolveDatabaseBackupArchive(file);
    fs.unlinkSync(archivePath);
    return jsonOk(c, 200, { status: 'deleted', file });
  } catch (error) {
    return jsonError(c, 404, 'delete_failed', error instanceof Error ? error.message : 'unknown error');
  }
});

app.get('/dev-tools/media-backups/download', (c) => {
  const target = String(c.req.query('target') || '').trim();
  const file = String(c.req.query('file') || '').trim();
  if (!isKnownMediaTarget(target)) {
    return jsonError(c, 400, 'invalid_target', 'invalid target', { valid: MEDIA_SYNC_TARGETS });
  }

  try {
    const archivePath = resolveMediaBackupArchive(target, file);
    const stat = fs.statSync(archivePath);
    const stream = fs.createReadStream(archivePath);
    c.header('Content-Type', 'application/zip');
    c.header('Content-Disposition', `attachment; filename="${path.basename(archivePath)}"`);
    c.header('Content-Length', String(stat.size));
    return c.body(stream, 200);
  } catch (error) {
    return jsonError(c, 404, 'archive_not_found', error instanceof Error ? error.message : 'unknown error');
  }
});

app.post('/dev-tools/media-backups/delete', async (c) => {
  const parsed = await parseBody(c, MediaDeleteBodySchema);
  if (!parsed.ok) {
    return parsed.response;
  }

  const target = parsed.data.target;
  const file = parsed.data.file;
  if (!isKnownMediaTarget(target)) {
    return jsonError(c, 400, 'invalid_target', 'invalid target', { valid: MEDIA_SYNC_TARGETS });
  }

  try {
    const archivePath = resolveMediaBackupArchive(target, file);
    fs.unlinkSync(archivePath);
    return jsonOk(c, 200, { status: 'deleted', target, file });
  } catch (error) {
    return jsonError(c, 404, 'delete_failed', error instanceof Error ? error.message : 'unknown error');
  }
});

app.post('/dev-tools/push-to-staging', async (c) => {
  if (productionWriteInProgress) {
    return jsonError(c, 409, 'production_promotion_running', 'cannot change staging while production promotion is running');
  }

  const op = DEV_OPS['/dev-tools/push-to-staging']();
  if (op.requiresStaging && !STAGING_WORKDIR) {
    return jsonError(c, 500, 'staging_root_missing', 'ASTRO_STAGING_SITE_ROOT is not configured');
  }
  if (op.requiresDb && (!db.dev.name || !db.staging.name)) {
    return jsonError(c, 500, 'db_env_missing', 'DB env vars not configured (DEV_DB_NAME / STAGING_DB_NAME)');
  }
  const started = startDevOp(op.key, op.label, op.run);
  if (!started) {
    return jsonError(c, 409, 'already_in_progress', 'already in progress');
  }
  return jsonOk(c, 202, { status: 'running' });
});

app.post('/dev-tools/:op', async (c) => {
  const opPath = `/dev-tools/${c.req.param('op')}`;
  const opDef = DEV_OPS[opPath];
  if (!opDef || typeof opDef === 'function') {
    return jsonError(c, 404, 'not_found', 'not found');
  }

  if (opDef.requiresStaging && !STAGING_WORKDIR) {
    return jsonError(c, 500, 'staging_root_missing', 'ASTRO_STAGING_SITE_ROOT is not configured');
  }
  if (opDef.requiresDb && (!db.dev.name || !db.staging.name)) {
    return jsonError(c, 500, 'db_env_missing', 'DB env vars not configured (DEV_DB_NAME / STAGING_DB_NAME)');
  }
  const started = startDevOp(opDef.key, opDef.label, opDef.run);
  if (!started) {
    return jsonError(c, 409, 'already_in_progress', 'already in progress');
  }
  return jsonOk(c, 202, { status: 'running' });
});

app.all('*', (c) => jsonError(c, 404, 'not_found', 'not found'));

const server = serve({
  fetch: app.fetch,
  port: PORT,
  hostname: '0.0.0.0',
}, () => {
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
