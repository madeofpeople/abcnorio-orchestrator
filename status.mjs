import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const WORKDIR = process.env.ASTRO_SITE_ROOT || '/astro-site';
const ARCHIVE_DIR = path.resolve(WORKDIR, 'build-archives');
const STATUS_FILE = process.env.ASTRO_DEPLOYMENT_STATUS_FILE
  ? path.resolve(process.env.ASTRO_DEPLOYMENT_STATUS_FILE)
  : path.resolve(WORKDIR, 'build-archives/deployment-status.json');
const PREVIEW_CANDIDATE_META = path.join(ARCHIVE_DIR, '.production-preview-candidate.meta');
const ENV_KEYS = ['dev', 'staging', 'production', 'preview'];

export function defaultRuntimeState() {
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

export function defaultEnvStatus() {
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
    backups: [],
  };
}

export function normalizeStatus(input) {
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

export function ensureEnvStatus(status, env) {
  normalizeStatus(status);
  return status.envs[env];
}

export function saveStatus(status) {
  const normalized = normalizeStatus(status);
  normalized.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
  fs.writeFileSync(STATUS_FILE, JSON.stringify(normalized, null, 2) + '\n');
}

export function markRequested(target) {
  const status = loadStatus();
  const envStatus = ensureEnvStatus(status, target);
  envStatus.lastRequestedAt = new Date().toISOString();
  saveStatus(status);
}

export function markStarted(target) {
  const status = loadStatus();
  const envStatus = ensureEnvStatus(status, target);
  envStatus.lastStartedAt = new Date().toISOString();
  envStatus.lastStatus = 'running';
  envStatus.lastError = null;
  saveStatus(status);
}

export function markDone(target) {
  const status = loadStatus();
  const envStatus = ensureEnvStatus(status, target);
  envStatus.lastFinishedAt = new Date().toISOString();
  envStatus.lastStatus = 'done';
  envStatus.lastError = null;
  saveStatus(status);
}

export function markFailed(target, message) {
  const status = loadStatus();
  const envStatus = ensureEnvStatus(status, target);
  envStatus.lastFinishedAt = new Date().toISOString();
  envStatus.lastStatus = 'failed';
  envStatus.lastError = message || 'job failed';
  saveStatus(status);
}

export function recordBackup(status, target, archivePath) {
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
  };

  envStatus.backups = [backup, ...envStatus.backups.filter((entry) => entry?.name !== name)]
    .slice(0, 12);
  envStatus.latestBackup = backup;
}

export function hasClientBuild(pathToBuildRoot) {
  const clientPath = path.join(pathToBuildRoot, 'client');
  return fs.existsSync(clientPath)
    && fs.readdirSync(clientPath).some((entry) => entry !== '.' && entry !== '..');
}

export function recordDeploy(status, target, deployBuildPath) {
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
  };
}

export function updateStatus(action, target, payload) {
  const status = loadStatus();

  if (action === 'backup') {
    recordBackup(status, target, payload.archivePath);
  } else if (action === 'deploy') {
    recordDeploy(status, target, payload.deployBuildPath);
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

export function removeBackupFromStatus(target, name) {
  const status = loadStatus();
  const envStatus = ensureEnvStatus(status, target);
  envStatus.backups = envStatus.backups.filter((b) => b?.name !== name);
  if (envStatus.latestBackup?.name === name) {
    envStatus.latestBackup = envStatus.backups[0] ?? null;
  }
  saveStatus(status);
}

/**
 * Compute a lightweight fingerprint of a directory: sorted list of relative paths + sizes.
 * Not cryptographically strong but sufficient to detect if the preview dir changed since
 * the candidate was captured.
 * @param {string} dirPath
 * @returns {string}
 */
export function dirFingerprint(dirPath) {
  const hash = createHash('sha256');

  function walk(dir, prefix = '') {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else {
        const stat = fs.statSync(path.join(dir, entry.name));
        hash.update(`${rel}:${stat.size}\n`);
      }
    }
  }

  walk(dirPath);
  return hash.digest('hex');
}

export function readPreviewCandidate() {
  if (!fs.existsSync(PREVIEW_CANDIDATE_META)) return null;
  try {
    const raw = fs.readFileSync(PREVIEW_CANDIDATE_META, 'utf8');
    const candidate = JSON.parse(raw);
    if (!candidate.archivePath || !candidate.fingerprint) return null;
    return candidate;
  } catch {
    return null;
  }
}

export function writePreviewCandidate(archivePath, fingerprint) {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  fs.writeFileSync(PREVIEW_CANDIDATE_META, JSON.stringify({ archivePath, fingerprint }, null, 2) + '\n');
}

export function clearPreviewCandidate() {
  try { fs.unlinkSync(PREVIEW_CANDIDATE_META); } catch { /* not present */ }
}
