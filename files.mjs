import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const WORKDIR = process.env.ASTRO_SITE_ROOT || '/astro-site';
const ARCHIVE_DIR = path.resolve(WORKDIR, 'build-archives');

export function listArchivesForTarget(target) {
  if (!fs.existsSync(ARCHIVE_DIR)) {
    return [];
  }

  const prefix = `abcnorio-astro-${target}-`;
  return fs
    .readdirSync(ARCHIVE_DIR)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.zip'));
}

export function runCommand(command, args) {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd: WORKDIR,
      env: process.env,
      stdio: 'inherit',
    });

    proc.on('close', (code) => {
      resolve(Number(code ?? 1));
    });
  });
}

export function cleanupOldArchives(target, maxKeep) {
  const names = listArchivesForTarget(target);
  if (names.length <= maxKeep) {
    return;
  }

  const sortedByMtime = names
    .map((name) => {
      const fullPath = path.join(ARCHIVE_DIR, name);
      return { name, fullPath, mtime: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  for (let i = maxKeep; i < sortedByMtime.length; i += 1) {
    try {
      fs.unlinkSync(sortedByMtime[i].fullPath);
    } catch (err) {
      console.warn(`failed to delete old archive ${sortedByMtime[i].name}:`, err.message);
    }
  }
}

export function assertDeployPath(target, deployBuildPath) {
  const resolved = String(deployBuildPath || '').trim();
  if (!resolved) {
    throw new Error(`missing deploy path for target=${target}`);
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`deploy path not found for target=${target}: ${resolved}`);
  }

  return resolved;
}
