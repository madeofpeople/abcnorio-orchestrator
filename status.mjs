import fs from 'node:fs';
import path from 'node:path';

const SOURCE_ROOT = process.env.ASTRO_SITE_ROOT || '/astro-site';
const WORKDIR = process.env.ASTRO_BUILD_WORKDIR || SOURCE_ROOT;
const ARCHIVE_DIR = process.env.ASTRO_BUILD_ARCHIVE_DIR
  ? path.resolve(process.env.ASTRO_BUILD_ARCHIVE_DIR)
  : path.resolve(WORKDIR, 'build-archives');
const STATUS_FILE = process.env.ASTRO_DEPLOYMENT_STATUS_FILE
  ? path.resolve(process.env.ASTRO_DEPLOYMENT_STATUS_FILE)
  : path.resolve(ARCHIVE_DIR, 'deployment-status.json');
const ENV_KEYS = ['dev', 'staging', 'production', 'preview'];

function defaultRuntimeState() {
  return {
    status: 'idle',
    target: null,
    started: null,
    finished: null,
    exitCode: null,
    message: null,
    updatedAt: null,
  };
}

function defaultEnvStatus() {
  return {
    lastRequestedAt: null,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastStatus: 'idle',
    lastError: null,
    currentBuild: {
      path: '',
      clientPath: '',
      hasBuild: false,
      updatedAt: null,
    },
    latestBackup: null,
    latestReleaseId: null,
    backups: [],
    lastSmoke: null,
    releases: [],
  };
}

function normalizeStatus(input) {
  const status = input && typeof input === 'object' ? input : {};

  const runtime = status.runtime && typeof status.runtime === 'object'
    ? status.runtime
    : {};
  const runtimeDefaults = defaultRuntimeState();
  status.runtime = {
    ...runtimeDefaults,
    ...runtime,
  };

  if (!status.envs || typeof status.envs !== 'object') {
    status.envs = {};
  }

  for (const env of ENV_KEYS) {
    const defaults = defaultEnvStatus();
    const envStatus = status.envs[env] && typeof status.envs[env] === 'object'
      ? status.envs[env]
      : {};

    const currentBuild = envStatus.currentBuild && typeof envStatus.currentBuild === 'object'
      ? envStatus.currentBuild
      : {};

    status.envs[env] = {
      ...defaults,
      ...envStatus,
      currentBuild: {
        ...defaults.currentBuild,
        ...currentBuild,
        hasBuild: Boolean(currentBuild.hasBuild),
      },
      backups: Array.isArray(envStatus.backups) ? envStatus.backups : [],
      releases: Array.isArray(envStatus.releases) ? envStatus.releases : [],
    };
  }

  return status;
}

export function loadStatus() {
  if (!fs.existsSync(STATUS_FILE)) {
    return normalizeStatus({});
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    return normalizeStatus(parsed);
  } catch {
    return normalizeStatus({});
  }
}

function ensureEnvStatus(status, env) {
  normalizeStatus(status);
  return status.envs[env];
}

function updateEnv(target, fn) {
  const status = loadStatus();
  fn(ensureEnvStatus(status, target));
  saveStatus(status);
}

export function saveStatus(status) {
  const normalized = normalizeStatus(status);
  normalized.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
  fs.writeFileSync(STATUS_FILE, JSON.stringify(normalized, null, 2) + '\n');
}

export function markRequested(target) {
  updateEnv(target, (env) => { env.lastRequestedAt = new Date().toISOString(); });
}

export function markStarted(target) {
  updateEnv(target, (env) => {
    env.lastStartedAt = new Date().toISOString();
    env.lastStatus = 'running';
    env.lastError = null;
  });
}

export function markDone(target) {
  updateEnv(target, (env) => {
    env.lastFinishedAt = new Date().toISOString();
    env.lastStatus = 'done';
    env.lastError = null;
  });
}

export function markFailed(target, message) {
  updateEnv(target, (env) => {
    env.lastFinishedAt = new Date().toISOString();
    env.lastStatus = 'failed';
    env.lastError = message || 'job failed';
  });
}

function recordBackup(status, target, archivePath, sourceCommitSha = null, releaseId = null, checksumSha256 = null) {
  const resolvedPath = path.resolve(archivePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`backup path does not exist: ${resolvedPath}`);
  }

  const stats = fs.statSync(resolvedPath);
  const name = path.basename(resolvedPath);
  const envStatus = ensureEnvStatus(status, target);
  const backup = {
    name,
    path: resolvedPath,
    createdAt: new Date(stats.mtimeMs).toISOString(),
    mtime: Math.floor(stats.mtimeMs / 1000),
    size: stats.size,
    sourceCommitSha,
    releaseId,
    checksumSha256,
  };

  envStatus.backups = [backup, ...envStatus.backups.filter((entry) => entry?.name !== name)]
    .slice(0, 12);
  envStatus.latestBackup = backup;
  envStatus.latestReleaseId = releaseId || envStatus.latestReleaseId;

  if (releaseId) {
    const release = {
      releaseId,
      sourceCommitSha,
      target,
      checksumSha256,
      archivePath: resolvedPath,
      createdAt: backup.createdAt,
    };
    envStatus.releases = [release, ...envStatus.releases.filter((entry) => entry?.releaseId !== releaseId)]
      .slice(0, 20);
  }
}

function hasClientBuild(pathToBuildRoot) {
  const clientPath = path.join(pathToBuildRoot, 'client');
  return fs.existsSync(clientPath)
    && fs.readdirSync(clientPath).some((entry) => entry !== '.' && entry !== '..');
}

function recordDeploy(status, target, deployBuildPath, releaseId = null, sourceCommitSha = null, checksumSha256 = null, artifactPath = null) {
  const resolvedBuildPath = path.resolve(deployBuildPath);
  const clientPath = path.join(resolvedBuildPath, 'client');
  const hasBuild = hasClientBuild(resolvedBuildPath);
  const envStatus = ensureEnvStatus(status, target);

  envStatus.currentBuild = {
    path: resolvedBuildPath,
    clientPath,
    hasBuild,
    updatedAt: new Date().toISOString(),
  };

  envStatus.lastDeploy = {
    updatedAt: new Date().toISOString(),
    path: resolvedBuildPath,
    hasBuild,
    releaseId,
    sourceCommitSha,
    checksumSha256,
    artifactPath,
  };

  if (releaseId) {
    envStatus.latestReleaseId = releaseId;
  }
}

export function updateStatus(action, target, payload) {
  const status = loadStatus();

  if (action === 'backup') {
    recordBackup(
      status,
      target,
      payload.archivePath,
      payload.sourceCommitSha || null,
      payload.releaseId || null,
      payload.checksumSha256 || null,
    );
  } else if (action === 'deploy') {
    recordDeploy(
      status,
      target,
      payload.deployBuildPath,
      payload.releaseId || null,
      payload.sourceCommitSha || null,
      payload.checksumSha256 || null,
      payload.artifactPath || null,
    );
  } else if (action === 'smoke') {
    const envStatus = ensureEnvStatus(status, target);
    envStatus.lastSmoke = {
      status: payload.passed ? 'passed' : 'failed',
      checkedAt: new Date().toISOString(),
      durationMs: payload.durationMs,
      requiredFailed: payload.requiredFailed,
      optionalFailed: payload.optionalFailed,
      checks: payload.checks,
    };
  } else {
    throw new Error(`unknown status action: ${action}`);
  }

  saveStatus(status);
}

export function setRuntimeState(nextState) {
  const status = loadStatus();
  status.runtime = {
    ...defaultRuntimeState(),
    ...status.runtime,
    ...nextState,
    updatedAt: new Date().toISOString(),
  };
  saveStatus(status);
}

export function getRuntimeState() {
  const status = loadStatus();
  return status.runtime;
}



