import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { enqueue, getQueueStatus } from './queue.mjs';
import { devToolsState, startDevOp, copyMediaFiles, createMediaBackupArchive, dumpDatabase, uploads, db, assertUploadsContract } from './dev-tools.mjs';
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
const STAGING_SUCCESS_RELEASES_TO_KEEP = Number(process.env.STAGING_SUCCESS_RELEASES_TO_KEEP || 2);
const STAGING_FAILED_RELEASES_TO_KEEP = Number(process.env.STAGING_FAILED_RELEASES_TO_KEEP || 1);

const SOURCE_ROOT = process.env.ASTRO_SITE_ROOT || '/astro-site';
const SOURCE_GIT_ROOT = process.env.ASTRO_SITE_GIT_ROOT || SOURCE_ROOT;
const SOURCE_GIT_SUBDIR = (process.env.ASTRO_SITE_GIT_SUBDIR || '').replace(/^\/+|\/+$/g, '');
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

  const stagingDeployTags = dirs.filter((name) => name.startsWith('staging-deploy-'));
  const successful = [];
  for (const tag of stagingDeployTags) {
    if (failedTag && tag === failedTag) {
      continue;
    }
    const fullPath = path.join(releasesRoot, tag);
    const stat = await fs.promises.stat(fullPath);
    successful.push({ tag, mtime: stat.mtimeMs });
  }

  successful.sort((a, b) => b.mtime - a.mtime);
  const keepSuccessful = new Set(successful.slice(0, STAGING_SUCCESS_RELEASES_TO_KEEP).map((item) => item.tag));
  if (successfulTag) {
    keepSuccessful.add(successfulTag);
  }

  const failedToKeep = new Set();
  if (failedTag && STAGING_FAILED_RELEASES_TO_KEEP > 0) {
    failedToKeep.add(failedTag);
  }

  for (const tag of stagingDeployTags) {
    if (keepSuccessful.has(tag) || failedToKeep.has(tag)) {
      continue;
    }
    await fs.promises.rm(path.join(releasesRoot, tag), { recursive: true, force: true });
  }
}

// Resolve git ref (branch, tag, or commit-ish) to commit SHA in SOURCE_GIT_ROOT.
async function resolveGitRef(ref) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
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

async function gitIsAncestor(ancestorRef, descendantRef) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['merge-base', '--is-ancestor', ancestorRef, descendantRef], {
      cwd: SOURCE_GIT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(true);
        return;
      }

      if (code === 1) {
        resolve(false);
        return;
      }

      reject(new Error(`Failed ancestry check ${ancestorRef} -> ${descendantRef}: ${stderr.trim()}`));
    });
    proc.on('error', (err) => {
      reject(new Error(`git process error: ${err.message}`));
    });
  });
}

async function fastForwardBranch(branchName, commitSha) {
  const existingBranchSha = await resolveGitRefIfExists(branchName);
  if (existingBranchSha) {
    const isAncestor = await gitIsAncestor(existingBranchSha, commitSha);
    if (!isAncestor) {
      throw new Error(`refusing non-fast-forward update for ${branchName}: ${existingBranchSha} is not ancestor of ${commitSha}`);
    }
  }

  const updateArgs = ['update-ref', `refs/heads/${branchName}`, commitSha];
  if (existingBranchSha) {
    updateArgs.push(existingBranchSha);
  }
  await runGitCommand(updateArgs);
  await runGitCommand(['push', 'origin', `refs/heads/${branchName}:refs/heads/${branchName}`]);
}

async function assertFastForwardPossible(branchName, commitSha) {
  const existingBranchSha = await resolveGitRefIfExists(branchName);
  if (!existingBranchSha) {
    return;
  }

  const isAncestor = await gitIsAncestor(existingBranchSha, commitSha);
  if (!isAncestor) {
    throw new Error(`refusing non-fast-forward update for ${branchName}: ${existingBranchSha} is not ancestor of ${commitSha}`);
  }
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
async function exportGitCommit(commitSha, targetDir) {
  return new Promise((resolve, reject) => {
    const archiveArgs = ['archive', '--format=tar', commitSha];
    if (SOURCE_GIT_SUBDIR) {
      archiveArgs.push(SOURCE_GIT_SUBDIR);
    }

    // Use tar format to preserve file permissions and symlinks
    const tarProc = spawn('git', archiveArgs, {
      cwd: SOURCE_GIT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stripComponents = SOURCE_GIT_SUBDIR ? SOURCE_GIT_SUBDIR.split('/').length : 0;
    const extractArgs = ['-xf', '-', '-C', targetDir];
    if (stripComponents > 0) {
      extractArgs.push(`--strip-components=${stripComponents}`);
    }

    // Extract tar stream directly to target directory
    const tarPath = spawn('tar', extractArgs, {
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
        reject(new Error(`npm install failed (code=${String(exitCode)}, signal=${String(exitSignal)}): ${reason}`));
      }
    });
    proc.on('error', (err) => {
      reject(new Error(`npm process error: ${err.message}`));
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
  if (hasLock) {
    try {
      await npmCi(dir);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[npm-install] npm ci failed in ${dir}; falling back to npm install --package-lock=false`);
      console.warn(`[npm-install] ci error: ${message}`);
      await npmInstall(dir);
      return;
    }
  }

  return npmInstall(dir);
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
  '/dev-tools/push-to-staging': (requestBody = {}) => ({
    key: 'push',
    label: 'push-to-staging',
    requiresStaging: true,
    run: async () => {
      const sentinelPath = path.join(STAGING_WORKDIR, '.push-in-progress');
      const stagingTagPrefix = 'staging-deploy-';
      let sourceTag = '';
      
      try { fs.writeFileSync(sentinelPath, ''); } catch { }
      try {
        sourceTag = String(requestBody.tag || '').trim();
        if (sourceTag) {
          console.log(`[push-to-staging] using requested tag ${sourceTag}`);
        } else {
          console.log(`[push-to-staging] resolving latest tag ${stagingTagPrefix}*`);
          sourceTag = await resolveLatestTagByPrefix(stagingTagPrefix);
        }
        const commitSha = await resolveGitRef(sourceTag);
        console.log(`[push-to-staging] selected tag ${sourceTag} → ${commitSha}`);

        const releaseDir = path.join(STAGING_RELEASES_ROOT, sourceTag);
        await clearDirectoryContents(releaseDir);
        console.log(`[push-to-staging] exporting commit ${commitSha} to release ${releaseDir}`);
        await exportGitCommit(commitSha, releaseDir);

        // Patch package.json to use the staging branch from GitHub.
        // This is a deploy-time override; the exported tag remains the source of truth,
        // but the install state must be reset so npm does not resolve a stale lockfile
        // from the pre-override dependency contract.
        const stagingPkgPath = path.join(releaseDir, 'package.json');
        const stagingPkg = JSON.parse(await fs.promises.readFile(stagingPkgPath, 'utf8'));
        const webcompDep = stagingPkg.dependencies?.['abcnorio-webcomponents'];

        if (webcompDep && (webcompDep.startsWith('file:') || webcompDep.startsWith('github:'))) {
          stagingPkg.dependencies['abcnorio-webcomponents'] = 'github:madeofpeople/abcnorio-webcomponents#staging';
          await fs.promises.writeFile(stagingPkgPath, JSON.stringify(stagingPkg, null, 2) + '\n', 'utf8');
          await fs.promises.rm(path.join(releaseDir, 'package-lock.json'), { force: true });
          console.log(`[push-to-staging] patched webcomponents to github:madeofpeople/abcnorio-webcomponents#staging`);
        }

        await assertStagingTreeContract(releaseDir);

        await fs.promises.rm(path.join(releaseDir, 'node_modules'), { recursive: true, force: true });
        await npmInstallDeterministic(releaseDir);
        await assertNodeModuleResolvable(releaseDir, 'astro');
        await assertNodeModuleResolvable(releaseDir, 'shiki');

        // Cut over active staging tree from prepared release.
        await clearDirectoryContentsExcept(STAGING_WORKDIR, ['releases', '.push-in-progress']);
        await copyDirectoryContents(releaseDir, STAGING_WORKDIR);
        await assertStagingTreeContract(STAGING_WORKDIR);

        await pruneStagingReleaseDirs(STAGING_RELEASES_ROOT, sourceTag);
        await fs.promises.rm(path.join(STAGING_RELEASES_ROOT, STAGING_LAST_FAILED_FILE), { force: true });

        return `Code pushed to staging from tag ${sourceTag} at ${commitSha}.`;
      } catch (error) {
        try {
          if (sourceTag) {
            await fs.promises.mkdir(STAGING_RELEASES_ROOT, { recursive: true });
            await fs.promises.writeFile(path.join(STAGING_RELEASES_ROOT, STAGING_LAST_FAILED_FILE), `${sourceTag}\n`, 'utf8');
          }
        } catch {
          // ignore failure marker write errors; do not mask root failure
        }
        throw error;
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
  const sourceCommitSha = await resolveGitRef('HEAD');

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
  const exitCode = await runCommand('bash', [DEPLOY_SCRIPT, target, scope], {
    ...process.env,
    SOURCE_COMMIT_SHA: sourceCommitSha,
  });
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

  const archivePath = path.join(STATIC_ARCHIVE_DIR, createdArchive);
  console.log(`[worker] ${target} found archive: ${path.basename(archivePath)}`);
  cleanupOldArchives(target, MAX_BACKUPS);
  updateStatus('backup', target, { archivePath, sourceCommitSha });
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

  if (target === 'production') {
    const tagName = await tagProductionDeploy(sourceCommitSha, Date.now());
    console.log(`[worker] production deploy tagged: ${tagName} @ ${sourceCommitSha}`);
  }

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
  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = requestUrl.pathname;

  const respond = (code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  if (req.method === 'GET' && pathname === '/health') {
    return respond(200, { status: 'ok' });
  }

  if (!SECRET || getAuthToken(req) !== SECRET) {
    return respond(401, { error: 'unauthorized' });
  }

  if (req.method === 'GET' && pathname === '/status') {
    return respond(200, getRuntimeState());
  }

  if (req.method === 'POST' && pathname === '/trigger') {
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

  if (req.method === 'POST' && pathname === '/restore') {
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

  if (req.method === 'GET' && pathname === '/dev-tools/status') {
    return respond(200, devToolsState);
  }

  if (req.method === 'GET' && pathname === '/dev-tools/media-backups') {
    const target = String(requestUrl.searchParams.get('target') || '').trim();
    if (!['dev', 'staging'].includes(target)) {
      return respond(400, { error: 'invalid target', valid: ['dev', 'staging'] });
    }

    return respond(200, {
      target,
      backups: listMediaBackups(target),
    });
  }

  if (req.method === 'GET' && pathname === '/dev-tools/media-backups/download') {
    const target = String(requestUrl.searchParams.get('target') || '').trim();
    const file = String(requestUrl.searchParams.get('file') || '').trim();
    if (!['dev', 'staging'].includes(target)) {
      return respond(400, { error: 'invalid target', valid: ['dev', 'staging'] });
    }

    try {
      const archivePath = resolveMediaBackupArchive(target, file);
      const stat = fs.statSync(archivePath);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${path.basename(archivePath)}"`,
        'Content-Length': String(stat.size),
      });
      fs.createReadStream(archivePath).pipe(res);
      return;
    } catch (error) {
      return respond(404, {
        error: 'archive not found',
        message: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }

  if (req.method === 'POST' && pathname === '/dev-tools/media-backups/delete') {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      return respond(400, { error: 'invalid json' });
    }

    const target = String(body.target || '').trim();
    const file = String(body.file || '').trim();
    if (!['dev', 'staging'].includes(target)) {
      return respond(400, { error: 'invalid target', valid: ['dev', 'staging'] });
    }

    try {
      const archivePath = resolveMediaBackupArchive(target, file);
      fs.unlinkSync(archivePath);
      return respond(200, { status: 'deleted', target, file });
    } catch (error) {
      return respond(404, {
        error: 'delete failed',
        message: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }

  if (req.method === 'POST' && DEV_OPS[pathname]) {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      // If body read fails, continue with empty body for backwards compat
      console.log(`[dev-tools] ignoring body read error: ${err.message}`);
    }
    
    // DEV_OPS entries can be operation objects or factory functions
    const opDefOrFactory = DEV_OPS[pathname];
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
