# Deploy Orchestrator

Orchestrates Astro static site deployments (production, preview) and dev/staging sync operations.

Just a tiny node server with no dependencies.

## File Structure

```
deploy-orchestrator/
├── scripts/
│   ├── backup-build.sh   # Archives build output to .zip
│   └── deploy.sh         # Full build pipeline (npm build + archive)
├── index.mjs             # HTTP server, routing, job orchestration
├── queue.mjs             # In-memory queue: concurrency 1, one pending slot
├── status.mjs            # Status file read/write, runtime state, mark* helpers
├── files.mjs             # Archive listing, cleanup, deploy path validation, restore
├── dev-tools.mjs         # Dev/staging sync: media copy, DB dump/restore, code push
├── http.mjs              # Auth token extraction, JSON body parsing
└── package.json
```

### Module Responsibilities

#### **index.mjs**
- HTTP server on `ORCHESTRATOR_PORT` (default 4011)
- Routes: `GET /health`, `GET /status`, `POST /trigger`, `POST /restore` (requires `release_id`), `POST /rollback`, `GET /releases`, `GET /dev-tools/status`, `POST /dev-tools/*`
- Auth via Bearer token (`ASTRO_BUILD_TRIGGER_SECRET`) — all routes except `/health`
- Builds the `buildJob` function: calls `deploy.sh`, enforces target-scoped archive contract, and deploys target-native artifacts only
- Graceful shutdown on SIGTERM/SIGINT: stops accepting requests, waits for queue to drain

#### **queue.mjs**
- In-memory queue, concurrency 1: one job running, one pending slot
- `enqueue(target, source, scope, fn)` → `{ accepted: true|false }`
- Returns 409 if a job is already pending (queue full)
- `getQueueStatus()` → `{ status: 'idle'|'running'|'queued', pendingTarget }`

#### **status.mjs**
- Canonical status file: `build-archives/deployment-status.json` under the build workdir
- Runtime state for `/status` response: `getRuntimeState`, `setRuntimeState`
- Per-environment tracking: `lastRequestedAt`, `lastStartedAt`, `lastFinishedAt`, `lastStatus`, `lastError`
- Build metadata: `currentBuild.{path, hasBuild, updatedAt}`
- Backup tracking: `latestBackup`, `backups[]`

#### **files.mjs**
- Archive discovery: `listArchivesForTarget(target)`
- Cleanup: `cleanupOldArchives(target, maxKeep)`
- Script execution: `runCommand(command, args)`
- Path validation: `assertDeployPath(target, path)`
- Archive restore: `restoreArchiveToTarget(target, archivePath, deployPath)`

#### **dev-tools.mjs**
- `copyMediaFiles(src, dest)` — `fs.promises.cp()` between upload dirs
- `dumpDatabase(src, dest)` — `mysqldump | mysql` pipe via child_process
- Dev-tools state tracking: `devToolsState`, `startDevOp()`

#### **Staging Push Guardrails**
- `POST /dev-tools/push-to-staging` exports approved tag into staging release dir, cuts over active staging tree, and prunes old releases.
- During push, orchestrator enforces staging tree contract (`package.json`, `astro.config.mjs`, `src/pages/index.astro`).
- Orchestrator performs deterministic dependency install in staging tree and verifies runtime deps resolve (`astro`, `shiki`) before reporting success.

#### **http.mjs**
- Auth token extraction from `Authorization: Bearer <token>`
- JSON body parsing from request streams

## Flow

### 1. Trigger (WordPress Plugin → Orchestrator)

```
WordPress Save Hook
       ↓
POST /trigger {target, source, scope}
       ↓
Validate auth + target
       ↓
enqueueTarget() → enqueue() in queue.mjs
```

### 2. Queue

```
queue status: idle → running → (queued) → idle

- idle:    job starts immediately
- running: new job accepted into pending slot (queued)
- queued:  second pending → rejected 409

No persistence. Queue lost on restart.
```

### 3. Worker Processing

```
buildJob(target, scope)
       ↓
setRuntimeState(running) + markStarted(target)
       ↓
runCommand('bash', [deploy.sh, target, scope])
       ↓
exit 0: find new archive, cleanup old, updateStatus, runSmokeChecks
exit ≠ 0: markFailed, throw
       ↓
smoke pass: markDone
smoke fail: markFailed, throw
```
### 4. Graceful Shutdown

On SIGTERM/SIGINT: stops accepting new HTTP requests, waits for any running build to finish (polls every 500ms), then exits cleanly. `stop_grace_period: 120s` in compose gives builds time to complete before Docker force-kills.

## Usage

### Trigger a Build

```bash
curl -X POST http://localhost:4011/trigger \
  -H "Authorization: Bearer $ASTRO_BUILD_TRIGGER_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"target":"production","source":"manual"}'

# Response: {"status":"queued","target":"production","source":"manual","scope":"full"}
# 409 if a job is already pending (queue full)
```

### Check Status (from the host)

```bash
curl http://localhost:4011/status \
  -H "Authorization: Bearer $ASTRO_BUILD_TRIGGER_SECRET"
```

### Check Health (no auth)

```bash
curl http://localhost:4011/health
# {"status":"ok"}
```

### Restore an Archive

```bash
curl -X POST http://localhost:4011/restore \
  -H "Authorization: Bearer $ASTRO_BUILD_TRIGGER_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"target":"production","file":"production-20260101-120000.zip"}'
```

### Environment Variables

| Variable | Default | Notes |
|----------|---------|-------|
| `ORCHESTRATOR_PORT` | 4011 | HTTP server port |
| `ASTRO_BUILD_TRIGGER_SECRET` | (required) | Bearer token for auth |
| `ORCHESTRATOR_ALLOW_MANUAL_TRIGGER` | 1 | Allow `source=manual` to `/trigger` |
| `MAX_BACKUPS` | 12 | Archive cleanup threshold per target |
| `PRODUCTION_HOST` | (none) | Public URL for production HTTP smoke probe (required; production gate fails if unset) |
| `PREVIEW_HOST` | (none) | Public URL for preview HTTP smoke probe (optional; skipped if unset) |
| `ORCHESTRATOR_SMOKE_HTTP_TIMEOUT_MS` | 10000 | Timeout in ms for each HTTP smoke probe |
| `PRODUCTION_BUILD_PATH` | (none) | Output path for production builds |
| `PREVIEW_BUILD_PATH` | (none) | Output path for preview builds |
| `ASTRO_SITE_ROOT` | /astro-site | Astro source directory (mount) |
| `ASTRO_BUILD_WORKDIR` | ASTRO_SITE_ROOT | Writable build scratch/work directory |
| `ASTRO_STAGING_SITE_ROOT` | (none) | Staging source directory for push ops |
| `ASTRO_DEPLOYMENT_STATUS_FILE` | (none) | Override status file path |
| `ORCHESTRATOR_SCRIPT_ROOT` | /orchestrator/scripts | Deploy script location |

## Testing

```bash
npm test
```

Tests use `node --test`. Coverage: archive listing, validation, path traversal rejection, deploy path validation.

## Notes

### Max Backups Cleanup
Cleanup runs after each successful build once the archive is discovered, before `markDone`. 
`MAX_BACKUPS` determined how many backups are saved.

### Queue Persistence
Jobs not yet running are lost on restart. Retriggering is cheap — WP plugin will re-enqueue on next save.
