import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const uploads = {
  staging: process.env.STAGING_UPLOADS_DIR || '/staging-uploads',
  dev: process.env.DEV_UPLOADS_DIR || '/dev-uploads',
  production: process.env.PRODUCTION_UPLOADS_PATH || '',
};

const SHARED_UID = Number(process.env.PROJECT_UID || 1000);
const SHARED_GID = Number(process.env.PROJECT_GID || 2000);
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
  syncRegeneratedThumbnailsToProduction: idleDevToolState(),
  backupDatabaseDev: idleDevToolState(),
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

export async function syncGeneratedImageDerivatives(src, dest) {
  const sourceStat = await fs.promises.stat(src);
  if (!sourceStat.isDirectory()) {
    throw new Error(`staging uploads path is not a directory: ${src}`);
  }

  if (!dest) {
    throw new Error('production uploads path is not configured');
  }

  const sourcePath = path.resolve(src);
  const destinationPath = path.resolve(dest);
  if (sourcePath === destinationPath) {
    throw new Error('staging and production uploads paths must differ');
  }

  const derivativePattern = /-\d+x\d+\.(?:avif|gif|jpe?g|png|webp)$/i;
  let copiedFiles = 0;
  let copiedBytes = 0;

  async function copyDirectory(sourceDirectory, destinationDirectory) {
    const entries = await fs.promises.readdir(sourceDirectory, { withFileTypes: true });

    for (const entry of entries) {
      const sourceFile = path.join(sourceDirectory, entry.name);
      const destinationFile = path.join(destinationDirectory, entry.name);

      if (entry.isDirectory()) {
        await copyDirectory(sourceFile, destinationFile);
        continue;
      }

      if (!entry.isFile() || !derivativePattern.test(entry.name)) {
        continue;
      }

      await fs.promises.mkdir(destinationDirectory, { recursive: true });
      await fs.promises.copyFile(sourceFile, destinationFile);
      copiedFiles += 1;
      copiedBytes += (await fs.promises.stat(sourceFile)).size;
    }
  }

  await copyDirectory(sourcePath, destinationPath);
  return { copiedFiles, copiedBytes };
}

// object-cache.php purges this site's APCu entries when this marker changes.
export function flushObjectCache(uploadsDir) {
  fs.writeFileSync(path.join(uploadsDir, '.object-cache-namespace'), String(Date.now()), { mode: 0o664 });
}

// Keep names and defaults in sync with BackupRetentionSettings.php in abcnorio-func.
const RETENTION_OPTIONS = {
  abcnorio_retention_production_archives: ['productionArchives', 3],
  abcnorio_retention_rollback_snapshots: ['rollbackSnapshots', 3],
  abcnorio_retention_media_backups: ['mediaBackups', 3],
  abcnorio_retention_database_backups: ['databaseBackups', 3],
};

// Retention is set in Settings > ABC No Rio on the staging site and read at prune time.
export async function readRetention() {
  const retention = Object.fromEntries(Object.values(RETENTION_OPTIONS));
  if (!db.staging.name) return retention;

  const names = Object.keys(RETENTION_OPTIONS).map((n) => `'${n}'`).join(',');
  try {
    const out = await runMysql(db.staging, `SELECT option_name, option_value FROM wp_options WHERE option_name IN (${names})`);
    for (const line of out.split('\n').filter(Boolean)) {
      const [option, value] = line.split('\t');
      const [key] = RETENTION_OPTIONS[option];
      retention[key] = Math.max(1, Number(value) || retention[key]);
    }
  } catch (error) {
    console.warn(`[retention] using defaults, could not read settings: ${error.message}`);
  }
  return retention;
}

async function cleanupOldMediaBackups(target) {
  const maxKeep = (await readRetention()).mediaBackups;
  if (!fs.existsSync(MEDIA_ARCHIVE_DIR)) {
    return;
  }

  const prefix = `abcnorio-media-${target}-`;
  const names = fs.readdirSync(MEDIA_ARCHIVE_DIR)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.zip'));

  if (names.length <= maxKeep) {
    return;
  }

  const sortedByMtime = names
    .map((name) => {
      const fullPath = path.join(MEDIA_ARCHIVE_DIR, name);
      return { name, fullPath, mtime: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  for (let i = maxKeep; i < sortedByMtime.length; i += 1) {
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

      cleanupOldMediaBackups(target).then(() => resolve(archiveName), reject);
    });

    zipProc.on('error', (error) => {
      reject(new Error(`zip process error: ${error.message}`));
    });
  });
}

function databaseBackupPrefix(target) {
  if (target !== 'dev' && target !== 'staging') {
    throw new Error(`invalid database backup target: ${target}`);
  }

  return `abcnorio-database-${target}-`;
}

async function cleanupOldDatabaseBackups(target) {
  if (!fs.existsSync(DATABASE_ARCHIVE_DIR)) return;

  const maxKeep = (await readRetention()).databaseBackups;
  const prefix = databaseBackupPrefix(target);
  const backups = fs.readdirSync(DATABASE_ARCHIVE_DIR)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.sql'))
    .map((name) => ({
      name,
      fullPath: path.join(DATABASE_ARCHIVE_DIR, name),
      mtime: fs.statSync(path.join(DATABASE_ARCHIVE_DIR, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const backup of backups.slice(maxKeep)) {
    try {
      fs.unlinkSync(backup.fullPath);
    } catch (error) {
      console.warn(`[backup-database-${target}] failed to delete old archive ${backup.name}: ${error.message}`);
    }
  }
}

export function listDatabaseBackups(target) {
  if (!fs.existsSync(DATABASE_ARCHIVE_DIR)) return [];

  const prefix = databaseBackupPrefix(target);
  return fs.readdirSync(DATABASE_ARCHIVE_DIR)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.sql'))
    .map((name) => ({
      name,
      mtime: fs.statSync(path.join(DATABASE_ARCHIVE_DIR, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
}

export function resolveDatabaseBackupArchive(requestedName, target) {
  const name = String(requestedName || '').trim();
  const prefix = databaseBackupPrefix(target);
  if (!name.startsWith(prefix) || !/^[a-zA-Z0-9_-]+\.sql$/.test(name.slice(prefix.length))) {
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

export function createDatabaseBackupArchive(source, target) {
  fs.mkdirSync(DATABASE_ARCHIVE_DIR, { recursive: true });

  const prefix = databaseBackupPrefix(target);
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const archiveName = `${prefix}${timestamp}.sql`;
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
      cleanupOldDatabaseBackups(target).then(() => resolve(archiveName), reject);
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

// Per-site options that must survive a DB sync. The Mailchimp OAuth token is
// encrypted with the site's salts, so a copy from another environment can't be decrypted.
const PRESERVE_OPTIONS = [
  'mailchimp_sf_access_token',
  'mailchimp_sf_auth_error',
  'mc_datacenter',
  'mc_api_key',
  'abcnorio_retention_production_archives',
  'abcnorio_retention_rollback_snapshots',
  'abcnorio_retention_media_backups',
  'abcnorio_retention_database_backups',
];

function runMysql(conn, sql) {
  return new Promise((resolve, reject) => {
    const proc = spawn('mysql', [
      `--host=${conn.host}`,
      `--user=${conn.user}`,
      '--ssl=FALSE',
      '--batch',
      '--skip-column-names',
      conn.name,
      '-e',
      sql,
    ], { env: { ...process.env, MYSQL_PWD: conn.password } });

    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => reject(new Error(`mysql error: ${e.message}`)));
    proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`mysql failed: ${err.trim()}`))));
  });
}

// Values travel as hex so encrypted/binary-ish strings survive the round trip.
async function readPreservedOptions(conn) {
  const names = PRESERVE_OPTIONS.map((n) => `'${n}'`).join(',');
  const out = await runMysql(conn, `SELECT option_name, HEX(option_value) FROM wp_options WHERE option_name IN (${names})`);
  return out.split('\n').filter(Boolean).map((line) => line.split('\t'));
}

async function writePreservedOptions(conn, saved) {
  const names = PRESERVE_OPTIONS.map((n) => `'${n}'`).join(',');
  const inserts = saved.map(([name, hex]) =>
    `INSERT INTO wp_options (option_name, option_value, autoload) VALUES ('${name}', UNHEX('${hex}'), 'no')`);
  await runMysql(conn, [`DELETE FROM wp_options WHERE option_name IN (${names})`, ...inserts].join('; '));
}

export async function dumpDatabase(src, dest) {
  const saved = await readPreservedOptions(dest);
  await copyDatabase(src, dest);
  await writePreservedOptions(dest, saved);
}

export function copyDatabase(src, dest) {
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

    let restoreCode = null;

    const finish = () => {
      if (dumpCode === null || restoreCode === null) return;
      if (dumpCode !== 0) {
        reject(new Error(`mysqldump failed: ${dumpErr.trim()}`));
      } else if (restoreCode !== 0) {
        reject(new Error(`mysql restore failed: ${restoreErr.trim()}`));
      } else {
        resolve();
      }
    };

    dump.on('close', (code) => {
      dumpCode = code;
      if (code !== 0) restore.stdin.destroy();
      finish();
    });

    restore.on('close', (code) => {
      restoreCode = code;
      finish();
    });

    dump.on('error', (err) => reject(new Error(`mysqldump error: ${err.message}`)));
    restore.on('error', (err) => reject(new Error(`mysql error: ${err.message}`)));
  });
}
