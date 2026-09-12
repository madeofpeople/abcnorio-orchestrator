import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const uploads = {
  staging: process.env.STAGING_UPLOADS_DIR || '/staging-uploads',
  dev: process.env.DEV_UPLOADS_DIR || '/dev-uploads',
};

const SHARED_UID = Number(process.env.PROJECT_UID || 1000);
const SHARED_GID = Number(process.env.PROJECT_GID || 2000);
const MAX_MEDIA_BACKUPS = Math.max(1, Number(process.env.MAX_MEDIA_BACKUPS || 2));
const MAX_DATABASE_BACKUPS = Math.max(1, Number(process.env.MAX_DATABASE_BACKUPS || 2));
const BASE_ARCHIVE_DIR = process.env.ASTRO_BUILD_ARCHIVE_DIR
  ? path.resolve(process.env.ASTRO_BUILD_ARCHIVE_DIR)
  : path.resolve(process.env.ASTRO_BUILD_WORKDIR || '/astro-build', 'build-archives');
const MEDIA_ARCHIVE_DIR = process.env.ASTRO_BUILD_MEDIA_ARCHIVE_DIR
  ? path.resolve(process.env.ASTRO_BUILD_MEDIA_ARCHIVE_DIR)
  : path.resolve(BASE_ARCHIVE_DIR, 'media');
const DATABASE_ARCHIVE_DIR = process.env.ASTRO_BUILD_DATABASE_ARCHIVE_DIR
  ? path.resolve(process.env.ASTRO_BUILD_DATABASE_ARCHIVE_DIR)
  : path.resolve(BASE_ARCHIVE_DIR, 'database');

function assertUploadsPathContract(label, uploadsPath) {
  let stat;
  try {
    stat = fs.statSync(uploadsPath);
  } catch (error) {
    throw new Error(`[startup] FATAL: ${label} uploads path missing: ${uploadsPath} (${error.message})`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`[startup] FATAL: ${label} uploads path is not a directory: ${uploadsPath}`);
  }

  const isRootlessMapped = stat.uid === 0;

  if (!isRootlessMapped && stat.uid !== SHARED_UID) {
    throw new Error(`[startup] FATAL: ${label} uploads UID is ${stat.uid} (expected ${SHARED_UID}) at ${uploadsPath}`);
  }

  if (!isRootlessMapped && stat.gid !== SHARED_GID) {
    throw new Error(`[startup] FATAL: ${label} uploads GID is ${stat.gid} (expected ${SHARED_GID}) at ${uploadsPath}`);
  }

  const mode = stat.mode & 0o7777;
  if ((mode & 0o2000) === 0) {
    throw new Error(`[startup] FATAL: ${label} uploads dir missing setgid bit (expected mode 2775) at ${uploadsPath}`);
  }

  if ((mode & 0o0020) === 0) {
    throw new Error(`[startup] FATAL: ${label} uploads dir is not group-writable at ${uploadsPath}`);
  }
}

export function assertUploadsContract() {
  const groups = process.getgroups();
  if (!groups.includes(SHARED_GID)) {
    throw new Error(`[startup] FATAL: process is missing required supplemental GID ${SHARED_GID}`);
  }

  assertUploadsPathContract('dev', uploads.dev);
  assertUploadsPathContract('staging', uploads.staging);
}

export const db = {
  staging: {
    host: process.env.STAGING_DB_HOST || 'mariadb',
    name: process.env.STAGING_DB_NAME || '',
    user: process.env.STAGING_DB_USER || '',
    password: process.env.STAGING_DB_PASSWORD || '',
  },
  dev: {
    host: process.env.DEV_DB_HOST || 'mariadb',
    name: process.env.DEV_DB_NAME || '',
    user: process.env.DEV_DB_USER || '',
    password: process.env.DEV_DB_PASSWORD || '',
  },
};

const idleDevToolState = () => ({ status: 'idle', started: null, finished: null, message: null });

export const devToolsState = {
  push: idleDevToolState(),
  copyMediaFromStagingToDev: idleDevToolState(),
  pullFromStagingToDev: idleDevToolState(),
  copyMediaToStagingFromDev: idleDevToolState(),
  pullDBFromDevToStaging: idleDevToolState(),
  backupMediaDev: idleDevToolState(),
  backupMediaStaging: idleDevToolState(),
  backupDatabaseStaging: idleDevToolState(),
};

function setDevToolState(key, status, started, message = null) {
  devToolsState[key] = {
    status,
    started,
    finished: status === 'running' ? null : Date.now(),
    message,
  };
}

export function startDevOp(key, label, asyncFn) {
  if (devToolsState[key].status === 'running') return false;
  const startedAt = Date.now();
  setDevToolState(key, 'running', startedAt);
  console.log(`[${label}] started`);
  asyncFn()
    .then((message) => {
      setDevToolState(key, 'done', startedAt, message);
      console.log(`[${label}] complete`);
    })
    .catch((err) => {
      setDevToolState(key, 'failed', startedAt, err.message);
      console.error(`[${label}] failed: ${err.message}`);
    });
  return true;
}

export function copyMediaFiles(src, dest) {
  return fs.promises.cp(src, dest, { recursive: true, force: false, errorOnExist: false });
}

function cleanupOldMediaBackups(target) {
  if (!fs.existsSync(MEDIA_ARCHIVE_DIR)) {
    return;
  }

  const prefix = `abcnorio-media-${target}-`;
  const names = fs.readdirSync(MEDIA_ARCHIVE_DIR)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.zip'));

  if (names.length <= MAX_MEDIA_BACKUPS) {
    return;
  }

  const sortedByMtime = names
    .map((name) => {
      const fullPath = path.join(MEDIA_ARCHIVE_DIR, name);
      return { name, fullPath, mtime: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  for (let i = MAX_MEDIA_BACKUPS; i < sortedByMtime.length; i += 1) {
    try {
      fs.unlinkSync(sortedByMtime[i].fullPath);
    } catch (error) {
      console.warn(`[backup-media-${target}] failed to delete old archive ${sortedByMtime[i].name}: ${error.message}`);
    }
  }
}

export function createMediaBackupArchive(sourceDir, target) {
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    return Promise.reject(new Error(`uploads source not found: ${sourceDir}`));
  }

  fs.mkdirSync(MEDIA_ARCHIVE_DIR, { recursive: true });

  const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const archiveName = `abcnorio-media-${target}-${ts}.zip`;
  const archivePath = path.join(MEDIA_ARCHIVE_DIR, archiveName);
  const parentDir = path.dirname(sourceDir);
  const baseName = path.basename(sourceDir);

  return new Promise((resolve, reject) => {
    const zipProc = spawn('zip', ['-qr', archivePath, baseName], {
      cwd: parentDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    zipProc.stderr.on('data', (d) => { stderr += d.toString(); });

    zipProc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`zip failed (${code}): ${stderr.trim()}`));
        return;
      }

      cleanupOldMediaBackups(target);
      resolve(archiveName);
    });

    zipProc.on('error', (error) => {
      reject(new Error(`zip process error: ${error.message}`));
    });
  });
}

function cleanupOldDatabaseBackups() {
  if (!fs.existsSync(DATABASE_ARCHIVE_DIR)) return;

  const backups = fs.readdirSync(DATABASE_ARCHIVE_DIR)
    .filter((name) => name.startsWith('abcnorio-database-staging-') && name.endsWith('.sql'))
    .map((name) => ({
      name,
      fullPath: path.join(DATABASE_ARCHIVE_DIR, name),
      mtime: fs.statSync(path.join(DATABASE_ARCHIVE_DIR, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const backup of backups.slice(MAX_DATABASE_BACKUPS)) {
    try {
      fs.unlinkSync(backup.fullPath);
    } catch (error) {
      console.warn(`[backup-database-staging] failed to delete old archive ${backup.name}: ${error.message}`);
    }
  }
}

export function listDatabaseBackups() {
  if (!fs.existsSync(DATABASE_ARCHIVE_DIR)) return [];

  return fs.readdirSync(DATABASE_ARCHIVE_DIR)
    .filter((name) => name.startsWith('abcnorio-database-staging-') && name.endsWith('.sql'))
    .map((name) => ({
      name,
      mtime: fs.statSync(path.join(DATABASE_ARCHIVE_DIR, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_DATABASE_BACKUPS);
}

export function resolveDatabaseBackupArchive(requestedName) {
  const name = String(requestedName || '').trim();
  if (!/^abcnorio-database-staging-[a-zA-Z0-9_-]+\.sql$/.test(name)) {
    throw new Error('invalid archive');
  }

  const archivePath = path.resolve(DATABASE_ARCHIVE_DIR, name);
  if (!archivePath.startsWith(`${DATABASE_ARCHIVE_DIR}${path.sep}`)) {
    throw new Error('invalid archive');
  }
  if (!fs.existsSync(archivePath) || !fs.statSync(archivePath).isFile()) {
    throw new Error('archive not found');
  }

  return archivePath;
}

export function createDatabaseBackupArchive(source) {
  fs.mkdirSync(DATABASE_ARCHIVE_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const archiveName = `abcnorio-database-staging-${timestamp}.sql`;
  const archivePath = path.join(DATABASE_ARCHIVE_DIR, archiveName);
  const tempPath = `${archivePath}.tmp`;

  return new Promise((resolve, reject) => {
    const dump = spawn('mysqldump', [
      `--host=${source.host}`,
      `--user=${source.user}`,
      '--ssl=FALSE',
      '--single-transaction',
      '--no-tablespaces',
      source.name,
    ], { env: { ...process.env, MYSQL_PWD: source.password } });
    const output = fs.createWriteStream(tempPath, { mode: 0o664 });
    let stderr = '';

    dump.stderr.on('data', (data) => { stderr += data.toString(); });
    dump.stdout.pipe(output);
    dump.on('close', (code) => {
      if (code !== 0) {
        output.destroy();
        fs.rmSync(tempPath, { force: true });
        reject(new Error(`mysqldump failed (${code}): ${stderr.trim()}`));
      }
    });
    output.on('finish', () => {
      if (!fs.existsSync(tempPath)) return;
      fs.renameSync(tempPath, archivePath);
      cleanupOldDatabaseBackups();
      resolve(archiveName);
    });
    dump.on('error', (error) => {
      output.destroy();
      fs.rmSync(tempPath, { force: true });
      reject(new Error(`mysqldump error: ${error.message}`));
    });
    output.on('error', (error) => {
      dump.kill();
      fs.rmSync(tempPath, { force: true });
      reject(new Error(`database archive error: ${error.message}`));
    });
  });
}

export function dumpDatabase(src, dest) {
  return new Promise((resolve, reject) => {
    const dump = spawn('mysqldump', [
      `--host=${src.host}`,
      `--user=${src.user}`,
      '--ssl=FALSE',
      '--single-transaction',
      '--no-tablespaces',
      src.name,
    ], { env: { ...process.env, MYSQL_PWD: src.password } });

    const restore = spawn('mysql', [
      `--host=${dest.host}`,
      `--user=${dest.user}`,
      '--ssl=FALSE',
      dest.name,
    ], { env: { ...process.env, MYSQL_PWD: dest.password } });

    dump.stdout.pipe(restore.stdin);

    let dumpErr = '';
    let restoreErr = '';
    let dumpCode = null;
    dump.stderr.on('data', (d) => { dumpErr += d.toString(); });
    restore.stderr.on('data', (d) => { restoreErr += d.toString(); });

    dump.on('close', (code) => {
      dumpCode = code;
      if (code !== 0) restore.stdin.destroy();
    });

    restore.on('close', (code) => {
      if (dumpCode !== 0) {
        reject(new Error(`mysqldump failed: ${dumpErr.trim()}`));
      } else if (code !== 0) {
        reject(new Error(`mysql restore failed: ${restoreErr.trim()}`));
      } else {
        resolve();
      }
    });

    dump.on('error', (err) => reject(new Error(`mysqldump error: ${err.message}`)));
    restore.on('error', (err) => reject(new Error(`mysql error: ${err.message}`)));
  });
}
