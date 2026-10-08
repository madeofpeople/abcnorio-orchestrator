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
const WEBCOMPONENTS_LOCK_KEY = 'node_modules/abcnorio-webcomponents';
const WEBCOMPONENTS_GIT_PREFIX = 'git+ssh://git@github.com/madeofpeople/abcnorio-webcomponents.git#';

function readWebcomponentsLockEntry(lockPath) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const entry = lock.packages?.[WEBCOMPONENTS_LOCK_KEY];
  const resolved = String(entry?.resolved || '');
  if (!resolved.startsWith(WEBCOMPONENTS_GIT_PREFIX)) {
    throw new Error(`webcomponents lock entry is not pinned to the expected Git repository: ${lockPath}`);
  }

  const sha = resolved.slice(WEBCOMPONENTS_GIT_PREFIX.length);
  if (!/^[a-f0-9]{40}$/i.test(sha)) {
    throw new Error(`webcomponents lock entry must resolve to a full commit SHA: ${lockPath}`);
  }

  return sha.toLowerCase();
}

export function readWebcomponentsShaFromLock(lockPath) {
  return readWebcomponentsLockEntry(lockPath);
}

export function assertInstalledWebcomponentsSha(siteRoot) {
  const packageLockPath = path.join(siteRoot, 'package-lock.json');
  const installedLockPath = path.join(siteRoot, 'node_modules/.package-lock.json');
  const expectedSha = readWebcomponentsLockEntry(packageLockPath);
  const installedSha = readWebcomponentsLockEntry(installedLockPath);

  if (installedSha !== expectedSha) {
    throw new Error('installed webcomponents package does not match package-lock.json');
  }

  return expectedSha;
}

export function assertStagingSourceSha(siteRoot, expectedSha) {
  const markerPath = path.join(siteRoot, '.staging-provenance.json');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  if (marker.sourceCommitSha !== expectedSha) {
    throw new Error('staging source SHA does not match deployment record');
  }
}

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
    stagingDeployment: {
      sourceCommitSha: '',
      webcomponentsCommitSha: '',
      releaseId: '',
      pluginVersion: '',
      preparedAt: null,
      verifiedAt: null,
      deployedAt: null,
    },
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
      stagingDeployment: {
        ...defaults.stagingDeployment,
        ...(envStatus.stagingDeployment && typeof envStatus.stagingDeployment === 'object'
          ? envStatus.stagingDeployment
          : {}),
      },
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

export function recordStagingDeployment(sourceCommitSha, webcomponentsCommitSha, releaseId, pluginVersion) {
  const sha = String(sourceCommitSha || '').trim();
  if (!/^[a-f0-9]{40}$/i.test(sha)) {
    throw new Error('staging deployment requires a full 40-character commit SHA');
  }
  const webcomponentsSha = String(webcomponentsCommitSha || '').trim();
  if (!/^[a-f0-9]{40}$/i.test(webcomponentsSha)) {
    throw new Error('staging deployment requires a full webcomponents commit SHA');
  }
  const version = String(pluginVersion || '').trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('staging deployment requires a valid plugin version');
  }

  updateEnv('staging', (env) => {
    env.stagingDeployment = {
      sourceCommitSha: sha.toLowerCase(),
      webcomponentsCommitSha: webcomponentsSha.toLowerCase(),
      releaseId: String(releaseId || '').trim(),
      pluginVersion: version,
      preparedAt: new Date().toISOString(),
      verifiedAt: null,
      deployedAt: null,
    };
  });
}

export function markStagingDeploymentVerified(releaseId, sourceCommitSha, webcomponentsCommitSha, pluginVersion) {
  updateEnv('staging', (env) => {
    const deployment = env.stagingDeployment;
    if (deployment.releaseId !== releaseId
      || deployment.sourceCommitSha !== sourceCommitSha
      || deployment.webcomponentsCommitSha !== webcomponentsCommitSha
      || deployment.pluginVersion !== pluginVersion) {
      throw new Error('staging verification does not match the prepared deployment');
    }

    const verifiedAt = new Date().toISOString();
    deployment.verifiedAt = verifiedAt;
    deployment.deployedAt = verifiedAt;
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



