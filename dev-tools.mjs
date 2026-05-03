import fs from 'node:fs';
import { spawn } from 'node:child_process';

export const uploads = {
  staging: process.env.STAGING_UPLOADS_DIR || '/staging-uploads',
  dev: process.env.DEV_UPLOADS_DIR || '/dev-uploads',
};

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

export const devToolsState = {
  push: { status: 'idle', started: null, finished: null, message: null },
  copyMediaFromStagingToDev: { status: 'idle', started: null, finished: null, message: null },
  pullFromStagingToDev: { status: 'idle', started: null, finished: null, message: null },
  copyMediaToStagingFromDev: { status: 'idle', started: null, finished: null, message: null },
  pullDBFromDevToStaging: { status: 'idle', started: null, finished: null, message: null },
};

export function startDevOp(key, label, asyncFn) {
  if (devToolsState[key].status === 'running') return false;
  const startedAt = Date.now();
  devToolsState[key] = { status: 'running', started: startedAt, finished: null, message: null };
  console.log(`[${label}] started`);
  asyncFn()
    .then((message) => {
      devToolsState[key] = { status: 'done', started: startedAt, finished: Date.now(), message };
      console.log(`[${label}] complete`);
    })
    .catch((err) => {
      devToolsState[key] = { status: 'failed', started: startedAt, finished: Date.now(), message: err.message };
      console.error(`[${label}] failed: ${err.message}`);
    });
  return true;
}

export function copyMediaFiles(src, dest) {
  return fs.promises.cp(src, dest, { recursive: true, force: false, errorOnExist: false });
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
