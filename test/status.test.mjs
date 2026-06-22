import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'abcnorio-status-test-'));
process.env.ASTRO_SITE_ROOT = tempRoot;

const archiveDir = path.join(tempRoot, 'build-archives');
fs.mkdirSync(archiveDir, { recursive: true });

const {
  loadStatus,
  recordBackup,
} = await import('../status.mjs');

const { saveStatus } = await import('../status.mjs');

