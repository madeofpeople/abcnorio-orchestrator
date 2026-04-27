# Deploy Orchestrator

Orchestrates Astro static site deployments across three environments (dev, staging, production) via Redis queue and BullMQ worker.

## File Structure

```
deploy-orchestrator/
├── scripts/
│   ├── backup-build.sh
│   └── deploy.sh
├── index.mjs           # Main: HTTP server, worker setup, trigger routing
├── status.mjs          # Status: loadStatus, saveStatus, mark* functions
├── files.mjs           # File operations: archive listing, cleanup, script execution
├── http.mjs            # HTTP utilities: auth token parsing, JSON body reading
├── package.json        # Dependencies: bullmq, ioredis
└── node_modules/
```

### Module Responsibilities

#### **index.mjs**
- HTTP server on port 4011 (default)
- Routes: `POST /trigger`, `GET /status`, `GET /health`
- Auth via Bearer token (`ASTRO_BUILD_TRIGGER_SECRET`)
- BullMQ Worker instance (concurrency=1, serialized execution)
- Job enqueueing logic with native BullMQ deduplication [`keepLastIfActive`](https://github.com/taskforcesh/bullmq/compare/v5.71.1...v5.72.0)
- Event handlers for job completion/failure

#### **status.mjs**
- Canonical status file operations (`build-archives/deployment-status.json`)
- Per-environment tracking: `lastRequestedAt`, `lastStartedAt`, `lastFinishedAt`, `lastStatus`, `lastError`
- Build metadata: `currentBuild.{path, clientPath, hasBuild, updatedAt}`
- Backup tracking: `latestBackup`, `backups[]` (tracks created zips)
- Schema normalization and validation

#### **files.mjs**
- Archive discovery: `listArchivesForTarget(target)`
- Cleanup: `cleanupOldArchives(target, maxKeep)` — removes old zips when limit exceeded
- Script execution: `runCommand(command, args)` — spawns bash with inherit stdio
- Path validation: `assertDeployPath(target, path)` — ensures build paths exist

#### **http.mjs**
- Auth token extraction from `Authorization: Bearer <token>` headers
- JSON body parsing from request streams
- Error handling for malformed JSON

## Flow

### 1. Trigger (WordPress Plugin → Orchestrator)

```
WordPress Save Hook
       ↓
POST /trigger with {target: 'staging', source: 'save'}
       ↓
Orchestrator validates auth + target
       ↓
enqueueTarget() adds BullMQ job with deduplication id deploy-<target>
```

### 2. Enqueue (Orchestrator → Redis)

```
Add job using BullMQ deduplication:
       queue.add('deploy', {target, source, scope}, {
              deduplication: { id: 'deploy-staging', keepLastIfActive: true }
       })
                      ↓
Behavior for same target dedup id:
       - If active: keep latest trigger payload, enqueue one follow-up automatically
       - If multiple triggers arrive while active: latest payload wins
       - No parallel runs for same dedup id
```

**Redis writes:**
- `bull:astro-build:*` keys: Job data, state, metadata
- Status file also written to disk via status.mjs

### 3. Worker Processing (Redis → Orchestrator → Scripts)

```
Worker listens on 'bull:astro-build' queue (via Redis connection)
       ↓
Job received: deploy-staging
       ↓
markStarted(target) → status file: lastStartedAt, lastStatus='running'
       ↓
runCommand('bash', ['/orchestrator/scripts/deploy.sh', 'staging'])
  - Sets: MODE=staging, BACKUP_TARGET=staging, BACKUP_SOURCE_DIR=/shared/static/staging
       - Runs: npm install → /orchestrator/scripts/backup-build.sh → npm run build:site
  - Output: dist/ artifacts copied to /shared/static/staging
       ↓
If exit code 0:
       require a newly-created archive for this run
       if missing: warn + fail job (contract violation)
  cleanupOldArchives(staging, MAX_BACKUPS) → Remove old .zip files
  updateStatus('backup', target, archivePath)
  markDone(target) → status file: lastFinishedAt, lastStatus='done'
       ↓
Else if exit code != 0:
  markFailed(target, error) → status file: lastStatus='failed', lastError
  Throw error (job marked failed in Redis)
```

**Redis operations during worker processing:**
- Write: Job status transitions (active → completed/failed)
- Event: Emit 'completed' or 'failed' event

### 4. Status Check (Client → Orchestrator → Status File)

```
GET /status
       ↓
Orchestrator returns current state object
       ↓
OR WordPress plugin reads status file directly:
  cat /shared/astro/build-archives/deployment-status.json
       ↓
Extract: envs.staging.currentBuild.hasBuild, lastFinishedAt, lastStatus
```

## Usage

### Trigger a Build

```bash
curl -X POST http://localhost:4011/trigger \
       -H "Authorization: Bearer $ASTRO_BUILD_TRIGGER_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"target":"staging","source":"manual"}'

# Response:
# {"status":"queued","target":"staging","source":"manual"}
```

### Run Deploy Script Directly

```bash
# Run deployment script directly (inside deploy-orchestrator container)
docker exec deploy-orchestrator sh -lc "bash /orchestrator/scripts/deploy.sh staging"
```

### Check Status

```bash
curl http://localhost:4011/status \
       -H "Authorization: Bearer $ASTRO_BUILD_TRIGGER_SECRET"

# Response:
# {"status":"running","target":"staging","started":1777207930000,...}
```

### Follow Build Progress

```bash
watch -n 1 'curl -s http://localhost:4011/status -H "Authorization: Bearer $ASTRO_BUILD_TRIGGER_SECRET" | python3 -m json.tool'
```

### Check Health

```bash
curl http://localhost:4011/health \
       -H "Authorization: Bearer $ASTRO_BUILD_TRIGGER_SECRET"

# Response: {"status":"ok"}
```

### Environment Variables

| Variable | Default | Notes |
|----------|---------|-------|
| `ORCHESTRATOR_PORT` | 4011 | HTTP server port |
| `ASTRO_BUILD_TRIGGER_SECRET` | (none) | Bearer token for auth |
| `REDIS_URL` | redis://redis:6379 | BullMQ queue backend |
| `BUILD_QUEUE_NAME` | astro-build | BullMQ queue name |
| `ORCHESTRATOR_ALLOW_MANUAL_TRIGGER` | 1 | Allow `source=manual` calls to `/trigger` |
| `MAX_BACKUPS` | 12 | Archive cleanup threshold |
| `DEV_BUILD_PATH` | (none) | Output path for dev builds |
| `STAGING_BUILD_PATH` | (none) | Output path for staging builds |
| `PRODUCTION_BUILD_PATH` | (none) | Output path for production builds |
| `ASTRO_SITE_ROOT` | /astro-site | Astro source directory |
| `ASTRO_DEPLOYMENT_STATUS_FILE` | (none) | Override status file path |

### Example Docker Exec

Note: manual trigger examples require `ORCHESTRATOR_ALLOW_MANUAL_TRIGGER=1`.

```bash
# Trigger staging build
docker exec deploy-orchestrator sh -c "curl -s -X POST http://localhost:4011/trigger \
  -H 'Authorization: Bearer $ASTRO_BUILD_TRIGGER_SECRET' \
  -H 'Content-Type: application/json' \
  -d '{\"target\":\"staging\"}'"

# Watch logs
docker logs -f deploy-orchestrator
```

## Testing

Run tests from the orchestrator root:

```bash
npm test
```

Current suite uses (`node --test`) and focuses on helper-level checks in `test/files.test.mjs`:

- archive listing (`listArchivesForTarget`)
- archive validation (`resolveArchiveForTarget`)
       - valid target-prefix acceptance
       - traversal/path-like rejection
       - missing archive rejection
- deploy path validation (`assertDeployPath`)

### Max Backups Cleanup

**Caveat:** Archive files older than `MAX_BACKUPS` are deleted **on disk** after each successful build.

**Timing:** Cleanup runs after script succeeds and archive is discovered, but before status is marked done.

**Data Loss Risk:** If cleanup threshold is very low (e.g., 1), only the current build remains on disk. No historical backups for recovery.

### Script Env Vars
Deploy scripts receive `MODE`, `BACKUP_TARGET`, `BACKUP_SOURCE_DIR`, `ASTRO_BUILD_BACKUP`. Mismatch with configured paths causes silent failures.

### Redis Persistence
If Redis restarts, queue is lost unless persistence configured (`RDB`/`AOF`).

## Monitoring

### Logs

```bash
# Full logs with timestamps
docker logs deploy-orchestrator

# Follow live
docker logs -f deploy-orchestrator

# Search for specific job
docker logs deploy-orchestrator | grep "staging"

# Count completed jobs
docker logs deploy-orchestrator | grep "worker:completed" | wc -l
```

### Status File

```bash
# Check current state
cat /shared/astro/build-archives/deployment-status.json | python3 -m json.tool

# Watch for updates
watch -n 5 "cat /shared/astro/build-archives/deployment-status.json | python3 -m json.tool"

# Latest build for staging
cat /shared/astro/build-archives/deployment-status.json | python3 -c "import sys, json; d=json.load(sys.stdin); print(d['envs']['staging']['currentBuild']['updatedAt'])"
```

### Redis Queue

```bash
# Inspect queue directly
docker exec redis redis-cli

# List all keys
KEYS "bull:astro-build:*"

# Get job details
HGETALL "bull:astro-build:deploy-staging"

# Check active queue keys
KEYS "bull:astro-build:*"
```

## Troubleshooting

**Jobs stuck in waiting state:**
- Check Redis connection: `docker logs deploy-orchestrator | grep "redis"`
- Verify concurrency=1 worker is active: `docker logs deploy-orchestrator | grep "worker:completed"`

**Build fails silently:**
- Check script: `docker logs deploy-orchestrator | grep "exit"`
- Verify build paths exist: `docker exec astro ls -la /shared/static/{dev,staging,prod}`

**Archive cleanup not running:**
- Verify orchestrator write perms: `ls -la /astro-site/build-archives/`
- Check `MAX_BACKUPS` env var (default 12)
