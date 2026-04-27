import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';

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

export function resolveArchiveForTarget(target, requestedName) {
  const name = String(requestedName || '').trim();
  const prefix = `abcnorio-astro-${target}-`;

  if (!name || !name.startsWith(prefix) || !name.endsWith('.zip')) {
    throw new Error('invalid archive');
  }

  if (name.includes('/') || name.includes('\\')) {
    throw new Error('invalid archive');
  }

  const archivePath = path.resolve(ARCHIVE_DIR, name);
  if (!archivePath.startsWith(`${ARCHIVE_DIR}${path.sep}`)) {
    throw new Error('invalid archive');
  }

  if (!fs.existsSync(archivePath) || !fs.statSync(archivePath).isFile()) {
    throw new Error('archive not found');
  }

  return archivePath;
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

function emptyDirectory(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    fs.rmSync(path.join(dirPath, entry.name), { recursive: true, force: true });
  }
}

function copyDirectoryContents(sourceDir, targetDir) {
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    fs.cpSync(sourcePath, targetPath, { recursive: true, force: true });
  }
}

export async function restoreArchiveToTarget(target, archivePath, deployBuildPath) {
  const resolvedDeployPath = assertDeployPath(target, deployBuildPath);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abcnorio-restore-'));

  try {
    const unzipExit = await runCommand('unzip', ['-qq', archivePath, '-d', tmpDir]);
    if (unzipExit !== 0) {
      throw new Error('failed to extract archive');
    }

    const extractedRoot = path.join(tmpDir, path.basename(resolvedDeployPath));
    if (!fs.existsSync(extractedRoot) || !fs.statSync(extractedRoot).isDirectory()) {
      throw new Error('invalid archive structure');
    }

    emptyDirectory(resolvedDeployPath);
    copyDirectoryContents(extractedRoot, resolvedDeployPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return resolvedDeployPath;
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
