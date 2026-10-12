import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const orchestratorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webcomponentsSha = 'b'.repeat(40);
const pluginVersion = '0.27.0';
const secret = 'promotion-test-secret';

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function git(repoPath, args) {
  execFileSync('git', args, { cwd: repoPath, stdio: 'ignore' });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createPromotionFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'astro-promotion-test-'));
  const sourceRoot = path.join(root, 'source');
  const gitRoot = path.join(root, 'git');
  const workdir = path.join(root, 'workdir');
  const stagingRoot = path.join(root, 'staging');
  const archiveRoot = path.join(root, 'archives');
  const staticArchiveDir = path.join(archiveRoot, 'static-backup');
  const productionPath = path.join(root, 'production-output');
  const scriptsRoot = path.join(root, 'scripts');
  const binRoot = path.join(root, 'bin');
  const stagingUploads = path.join(root, 'staging-uploads');
  const devUploads = path.join(root, 'dev-uploads');
  const statusFile = path.join(root, 'deployment-status.json');
  const extractRoot = path.join(root, 'extract', path.basename(productionPath));

  for (const dir of [sourceRoot, gitRoot, workdir, stagingRoot, staticArchiveDir, productionPath, scriptsRoot, binRoot]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const uploadsPath of [stagingUploads, devUploads]) {
    fs.mkdirSync(uploadsPath, { recursive: true });
    fs.chmodSync(uploadsPath, 0o2770);
  }

  const lock = {
    lockfileVersion: 3,
    packages: {
      'node_modules/abcnorio-webcomponents': {
        version: '2.47.3',
        resolved: `git+ssh://git@github.com/madeofpeople/abcnorio-webcomponents.git#${webcomponentsSha}`,
      },
    },
  };
  writeJson(path.join(gitRoot, 'package-lock.json'), lock);
  git(gitRoot, ['init', '--quiet']);
  git(gitRoot, ['add', 'package-lock.json']);
  execFileSync('git', [
    '-c', 'user.name=Promotion Test',
    '-c', 'user.email=promotion-test@example.invalid',
    'commit', '-m', 'promotion fixture',
  ], { cwd: gitRoot, stdio: 'ignore' });
  const sourceCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gitRoot, encoding: 'utf8' }).trim();

  writeJson(path.join(stagingRoot, 'package-lock.json'), lock);
  writeJson(path.join(stagingRoot, 'node_modules/.package-lock.json'), lock);
  writeJson(path.join(stagingRoot, '.staging-provenance.json'), { sourceCommitSha });

  for (const [relativePath, content] of [
    ['client/index.html', 'new client'],
    ['.ssr/server/entry.mjs', 'new server'],
    ['.ssr/client/entry.js', 'new SSR client'],
    ['.ssr/.deploy-version', 'promotion-fixture'],
  ]) {
    const filePath = path.join(extractRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }

  fs.mkdirSync(path.join(productionPath, 'client'), { recursive: true });
  fs.mkdirSync(path.join(productionPath, '.ssr/server'), { recursive: true });
  fs.writeFileSync(path.join(productionPath, 'client/old.html'), 'old client');
  fs.writeFileSync(path.join(productionPath, '.ssr/server/old.mjs'), 'old server');
  fs.writeFileSync(path.join(productionPath, '.ssr/.deploy-version'), 'old-version');

  const deployScript = [
    '#!/bin/bash',
    'set -euo pipefail',
    'mkdir -p node_modules/abcnorio-webcomponents/src/design-tokens',
    'cp package-lock.json node_modules/.package-lock.json',
    'archive="$ASTRO_BUILD_STATIC_ARCHIVE_DIR/abcnorio-astro-production-promotion-${SOURCE_COMMIT_SHA:0:7}.zip"',
    "printf 'promotion fixture archive' > \"$archive\"",
    '',
  ].join('\n');
  fs.writeFileSync(path.join(scriptsRoot, 'deploy.sh'), deployScript, { mode: 0o755 });
  fs.writeFileSync(path.join(scriptsRoot, 'warm-cache.sh'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });

  const unzipStub = `#!/bin/bash
set -euo pipefail
test "$1" = "-qq"
test -f "$2"
destination="$4/$(basename "$PRODUCTION_BUILD_PATH")"
mkdir -p "$destination"
cp -R "$TEST_EXTRACT_ROOT/." "$destination/"
`;
  fs.writeFileSync(path.join(binRoot, 'unzip'), unzipStub, { mode: 0o755 });

  const server = createServer((req, res) => {
    if (req.url === '/plugin-version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: pluginVersion }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  const httpPort = await listen(server);
  const portProbe = createServer();
  const orchestratorPort = await listen(portProbe);
  await closeServer(portProbe);
  const baseUrl = `http://127.0.0.1:${httpPort}`;

  const gid = process.getgid();
  assert.ok(process.getgroups().includes(gid), 'primary group must be in supplementary groups');
  const env = {
    PATH: `${binRoot}:${process.env.PATH}`,
    HOME: root,
    ASTRO_BUILD_TRIGGER_SECRET: secret,
    ASTRO_SITE_ROOT: sourceRoot,
    ASTRO_SITE_GIT_ROOT: gitRoot,
    ASTRO_BUILD_WORKDIR: workdir,
    ASTRO_BUILD_ARCHIVE_DIR: archiveRoot,
    ASTRO_BUILD_STATIC_ARCHIVE_DIR: staticArchiveDir,
    ASTRO_STAGING_SITE_ROOT: stagingRoot,
    ASTRO_STAGING_RELEASES_ROOT: path.join(root, 'staging-releases'),
    ASTRO_DEPLOYMENT_STATUS_FILE: statusFile,
    ORCHESTRATOR_SCRIPT_ROOT: scriptsRoot,
    ORCHESTRATOR_PORT: String(orchestratorPort),
    PRODUCTION_BUILD_PATH: productionPath,
    PREVIEW_BUILD_PATH: path.join(root, 'preview-output'),
    PRODUCTION_HOST: baseUrl,
    STAGING_HEALTH_URL: `${baseUrl}/cms-health`,
    STAGING_FRONTEND_HEALTH_URL: `${baseUrl}/frontend-health`,
    STAGING_PLUGIN_VERSION_URL: `${baseUrl}/plugin-version`,
    STAGING_UPLOADS_DIR: stagingUploads,
    DEV_UPLOADS_DIR: devUploads,
    PROJECT_UID: String(process.getuid()),
    PROJECT_GID: String(gid),
    TEST_EXTRACT_ROOT: extractRoot,
  };

  writeJson(statusFile, {
    envs: {
      staging: {
        stagingDeployment: {
          sourceCommitSha,
          webcomponentsCommitSha: webcomponentsSha,
          releaseId: 'staging-release-fixture',
          pluginVersion,
          preparedAt: '2026-10-12T00:00:00.000Z',
          verifiedAt: '2026-10-12T00:01:00.000Z',
          deployedAt: '2026-10-12T00:01:00.000Z',
        },
      },
    },
  });

  let stderr = '';
  const child = spawn(process.execPath, ['index.mjs'], {
    cwd: orchestratorRoot,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([exited, delay(1000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  };

  const healthUrl = `http://127.0.0.1:${orchestratorPort}/health`;
  const readyDeadline = Date.now() + 5000;
  while (Date.now() < readyDeadline) {
    if (child.exitCode !== null) {
      await stop();
      throw new Error(`orchestrator exited during startup: ${stderr}`);
    }
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return { root, child, env, sourceCommitSha, statusFile, staticArchiveDir, productionPath, healthUrl, stop, stderr: () => stderr };
    } catch {}
    await delay(20);
  }

  await stop();
  throw new Error(`orchestrator did not become ready: ${stderr}`);
}

test('promote-staging rejects mismatched inputs, then completes a Production promotion', async (t) => {
  const fixture = await createPromotionFixture();
  t.after(fixture.stop);

  const auth = { authorization: `Bearer ${secret}` };
  const statusFile = JSON.parse(fs.readFileSync(fixture.statusFile, 'utf8'));
  statusFile.envs.staging.stagingDeployment.webcomponentsCommitSha = 'c'.repeat(40);
  writeJson(fixture.statusFile, statusFile);

  const rejected = await fetch(fixture.healthUrl.replace('/health', '/promote-staging'), {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(rejected.status, 409);
  assert.match((await rejected.json()).error.message, /webcomponents SHA/);
  assert.deepEqual(fs.readdirSync(fixture.staticArchiveDir), []);

  statusFile.envs.staging.stagingDeployment.webcomponentsCommitSha = webcomponentsSha;
  writeJson(fixture.statusFile, statusFile);
  const accepted = await fetch(fixture.healthUrl.replace('/health', '/promote-staging'), {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).data.source_commit_sha, fixture.sourceCommitSha);

  const statusUrl = fixture.healthUrl.replace('/health', '/status');
  const deadline = Date.now() + 10000;
  let runtime;
  while (Date.now() < deadline) {
    const response = await fetch(statusUrl, { headers: auth });
    runtime = (await response.json()).data;
    if (runtime.status === 'done' || runtime.status === 'failed') break;
    await delay(25);
  }

  assert.equal(runtime?.status, 'done', `${runtime?.message || 'promotion timed out'}\n${fixture.stderr()}`);
  assert.equal(runtime.target, 'production');
  assert.equal(fs.readFileSync(path.join(fixture.productionPath, 'client/index.html'), 'utf8'), 'new client');
  assert.equal(fs.readFileSync(path.join(fixture.productionPath, '.ssr/server/entry.mjs'), 'utf8'), 'new server');
  assert.equal(fs.readFileSync(path.join(fixture.productionPath, '.ssr/.deploy-version'), 'utf8'), 'promotion-fixture');
  assert.equal(fs.existsSync(path.join(fixture.productionPath, 'client/old.html')), false);
  assert.equal(fs.existsSync(path.join(fixture.productionPath, '.ssr/server/old.mjs')), false);
  const deploymentStatus = JSON.parse(fs.readFileSync(fixture.statusFile, 'utf8'));
  assert.equal(deploymentStatus.envs.production.lastStatus, 'done');
  assert.equal(deploymentStatus.envs.production.lastError, null);
});