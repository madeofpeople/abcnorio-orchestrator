import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'abcnorio-status-test-'));
process.env.ASTRO_DEPLOYMENT_STATUS_FILE = path.join(tempRoot, 'deployment-status.json');
process.env.ASTRO_SITE_ROOT = tempRoot;

const {
  loadStatus,
  assertInstalledWebcomponentsSha,
  assertStagingSourceSha,
  markStagingDeploymentVerified,
  readWebcomponentsShaFromLock,
  recordBackup,
  recordStagingDeployment,
  saveStatus,
} = await import('../status.mjs?staging-release-test');

test('recordStagingDeployment persists frontend and webcomponents SHAs, release id, and plugin version', () => {
  const sha = 'a52e3f131dc41715ed26885e2e35865241b83ab3';
  const webcomponentsSha = '6e00567fd9ea975d92fdc1e3f46b649896ff4b09';
  recordStagingDeployment(sha, webcomponentsSha, 'staging-release-2026-09-29-a52e3f1', '0.24.0');

  const status = loadStatus();
  assert.equal(status.envs.staging.stagingDeployment.sourceCommitSha, sha);
  assert.equal(status.envs.staging.stagingDeployment.webcomponentsCommitSha, webcomponentsSha);
  assert.equal(status.envs.staging.stagingDeployment.releaseId, 'staging-release-2026-09-29-a52e3f1');
  assert.equal(status.envs.staging.stagingDeployment.pluginVersion, '0.24.0');
  assert.ok(status.envs.staging.stagingDeployment.preparedAt);
  assert.equal(status.envs.staging.stagingDeployment.verifiedAt, null);
  assert.equal(status.envs.staging.stagingDeployment.deployedAt, null);
  markStagingDeploymentVerified('staging-release-2026-09-29-a52e3f1', sha, webcomponentsSha, '0.24.0');
  assert.ok(loadStatus().envs.staging.stagingDeployment.verifiedAt);
});

test('recordStagingDeployment rejects an abbreviated SHA', () => {
  assert.throws(() => recordStagingDeployment('a52e3f1', 'a'.repeat(40), 'release', '0.24.0'), /full 40-character commit SHA/);
});

test('recordStagingDeployment rejects an abbreviated webcomponents SHA', () => {
  assert.throws(() => recordStagingDeployment('a'.repeat(40), '6e00567', 'release', '0.24.0'), /full webcomponents commit SHA/);
});

test('recordStagingDeployment rejects a missing plugin version', () => {
  assert.throws(() => recordStagingDeployment('a'.repeat(40), 'b'.repeat(40), 'release', ''), /valid plugin version/);
});

test('readWebcomponentsShaFromLock reads the resolved package commit, not a branch name', () => {
  const lockPath = path.join(tempRoot, 'package-lock.json');
  const sha = '4ab48716dec2a5ab35ad17eb35f3771b19d52811';
  fs.writeFileSync(lockPath, JSON.stringify({
    packages: {
      'node_modules/abcnorio-webcomponents': {
        version: '2.47.3',
        resolved: `git+ssh://git@github.com/madeofpeople/abcnorio-webcomponents.git#${sha}`,
      },
    },
  }));

  assert.equal(readWebcomponentsShaFromLock(lockPath), sha);
});

test('assertInstalledWebcomponentsSha requires the npm installed lock to match the package lock SHA', () => {
  const siteRoot = path.join(tempRoot, 'installed-site');
  const sha = '4ab48716dec2a5ab35ad17eb35f3771b19d52811';
  const lockEntry = {
    version: '2.47.3',
    resolved: `git+ssh://git@github.com/madeofpeople/abcnorio-webcomponents.git#${sha}`,
  };
  fs.mkdirSync(path.join(siteRoot, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(siteRoot, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/abcnorio-webcomponents': lockEntry } }));
  fs.writeFileSync(path.join(siteRoot, 'node_modules/.package-lock.json'), JSON.stringify({ packages: { 'node_modules/abcnorio-webcomponents': lockEntry } }));
  assert.equal(assertInstalledWebcomponentsSha(siteRoot), sha);

  const mismatchedEntry = { ...lockEntry, resolved: `${lockEntry.resolved.slice(0, -40)}${'b'.repeat(40)}` };
  fs.writeFileSync(path.join(siteRoot, 'node_modules/.package-lock.json'), JSON.stringify({ packages: { 'node_modules/abcnorio-webcomponents': mismatchedEntry } }));
  assert.throws(() => assertInstalledWebcomponentsSha(siteRoot), /does not match package-lock/);
});

test('assertStagingSourceSha checks the snapshot marker against the deployment SHA', () => {
  const siteRoot = path.join(tempRoot, 'staging-site');
  fs.mkdirSync(siteRoot, { recursive: true });
  fs.writeFileSync(path.join(siteRoot, '.staging-provenance.json'), JSON.stringify({ sourceCommitSha: 'a'.repeat(40) }));

  assert.doesNotThrow(() => assertStagingSourceSha(siteRoot, 'a'.repeat(40)));
  assert.throws(() => assertStagingSourceSha(siteRoot, 'b'.repeat(40)), /does not match deployment record/);
});

