import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';

const SOURCE_ROOT = process.env.ASTRO_SITE_ROOT || '/astro-site';
const WORKDIR = process.env.ASTRO_BUILD_WORKDIR || SOURCE_ROOT;
const BASE_ARCHIVE_DIR = process.env.ASTRO_BUILD_ARCHIVE_DIR
  ? path.resolve(process.env.ASTRO_BUILD_ARCHIVE_DIR)
  : path.resolve(WORKDIR, 'build-archives');
const STATIC_ARCHIVE_DIR = process.env.ASTRO_BUILD_STATIC_ARCHIVE_DIR
  ? path.resolve(process.env.ASTRO_BUILD_STATIC_ARCHIVE_DIR)
  : path.resolve(BASE_ARCHIVE_DIR, 'static-backup');

export function listArchivesForTarget(target) {
  if (!fs.existsSync(STATIC_ARCHIVE_DIR)) {
    return [];
  }

  const prefix = `abcnorio-astro-${target}-`;
  return fs
    .readdirSync(STATIC_ARCHIVE_DIR)
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

  const archivePath = path.resolve(STATIC_ARCHIVE_DIR, name);
  if (!archivePath.startsWith(`${STATIC_ARCHIVE_DIR}${path.sep}`)) {
    throw new Error('invalid archive');
  }

  if (!fs.existsSync(archivePath) || !fs.statSync(archivePath).isFile()) {
    throw new Error('archive not found');
  }

  return archivePath;
}

export function extractReleaseIdFromArchiveName(target, archiveName) {
  const name = String(archiveName || '').trim();
  const prefix = `abcnorio-astro-${target}-`;
  if (!name.startsWith(prefix) || !name.endsWith('.zip')) {
    return null;
  }

  const releaseId = name.slice(prefix.length, -4);
  if (!releaseId || releaseId.includes('/') || releaseId.includes('\\')) {
    return null;
  }

  return releaseId;
}

export function resolveArchiveForTargetByReleaseId(target, releaseId) {
  const cleanReleaseId = String(releaseId || '').trim();
  if (!cleanReleaseId || cleanReleaseId.includes('/') || cleanReleaseId.includes('\\')) {
    throw new Error('invalid release_id');
  }

  const archiveName = `abcnorio-astro-${target}-${cleanReleaseId}.zip`;
  return resolveArchiveForTarget(target, archiveName);
}

export function runCommand(command, args, env = process.env) {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd: WORKDIR,
      env,
      stdio: 'inherit',
    });

    proc.on('close', (code) => {
      resolve(Number(code ?? 1));
    });
  });
}

export async function restoreArchiveToTarget(target, archivePath, deployBuildPath) {
  const resolvedDeployPath = assertDeployPath(target, deployBuildPath);
  const expectedRootName = path.basename(resolvedDeployPath);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abcnorio-restore-'));

  try {
    const unzipExit = await runCommand('unzip', ['-qq', archivePath, '-d', tmpDir]);
    if (unzipExit !== 0) {
      throw new Error('failed to extract archive');
    }

    const extractedEntries = fs.readdirSync(tmpDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== '__MACOSX');
    if (extractedEntries.length !== 1) {
      throw new Error('invalid archive structure');
    }
    const extractedRootEntry = extractedEntries[0];
    if (extractedRootEntry.name !== expectedRootName) {
      throw new Error(`invalid archive root: expected ${expectedRootName}, got ${extractedRootEntry.name}`);
    }
    const extractedRoot = path.join(tmpDir, extractedRootEntry.name);

    const entries = fs.readdirSync(resolvedDeployPath, { withFileTypes: true });
    for (const entry of entries) {
      const destinationPath = path.join(resolvedDeployPath, entry.name);
      if (target === 'production' && entry.name === '.ssr' && entry.isDirectory()) {
        const ssrEntries = fs.readdirSync(destinationPath, { withFileTypes: true });
        for (const ssrEntry of ssrEntries) {
          fs.rmSync(path.join(destinationPath, ssrEntry.name), { recursive: true, force: true });
        }
        continue;
      }
      fs.rmSync(destinationPath, { recursive: true, force: true });
    }

    const extractedRootEntries = fs.readdirSync(extractedRoot, { withFileTypes: true });
    for (const entry of extractedRootEntries) {
      const sourcePath = path.join(extractedRoot, entry.name);
      const destinationPath = path.join(resolvedDeployPath, entry.name);

      if (target === 'production' && entry.name === '.ssr' && entry.isDirectory()) {
        fs.mkdirSync(destinationPath, { recursive: true });

        const ssrSourceEntries = fs.readdirSync(sourcePath, { withFileTypes: true });
        for (const ssrEntry of ssrSourceEntries) {
          if (ssrEntry.name === '.deploy-version') {
            continue;
          }
          fs.cpSync(
            path.join(sourcePath, ssrEntry.name),
            path.join(destinationPath, ssrEntry.name),
            { recursive: true, force: true }
          );
        }

        const sentinelSourcePath = path.join(sourcePath, '.deploy-version');
        if (fs.existsSync(sentinelSourcePath)) {
          fs.cpSync(sentinelSourcePath, path.join(destinationPath, '.deploy-version'), { force: true });
        }
        continue;
      }

      fs.cpSync(sourcePath, destinationPath, { recursive: true, force: true });
    }
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
      const fullPath = path.join(STATIC_ARCHIVE_DIR, name);
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
