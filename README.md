# Deploy Orchestrator

Orchestrates Astro static site deployments across three environments (dev, staging, production) via Redis queue and BullMQ worker.

## File Structure

```
deploy-orchestrator/
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
- Job enqueueing logic with state tracking
- Event handlers for job completion/failure

#### **status.mjs**
- Canonical status file operations (`build-archives/deployment-status.json`)
- Per-environment tracking: `lastRequestedAt`, `lastStartedAt`, `lastFinishedAt`, `lastStatus`, `lastError`
- Build metadata: `currentBuild.{path, clientPath, hasBuild, updatedAt}`
- Backup tracking: `latestBackup`, `backups[]` (tracks created zips)
- Schema normalization and validation

#### ***files.mjs**
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
enqueueTarget() checks for existing job
```

### 2. Enqueue (Orchestrator → Redis)

```
If already running for target:
  Set Redis key: build:astro:followup:staging = "1"
  Return 202 (queued_followup)
       ↓
Else if old job in failed/completed state:
  Remove it from Redis queue
       ↓
Add new job to queue:
  queue.add('deploy', {target, source}, {jobId: 'deploy-staging', delay, ...})
  Return 202 (queued)
```

**Redis writes:**
- `bull:astro-build:*` keys: Job data, state, metadata
- `build:astro:followup:staging` (optional): Marker if concurrent trigger received
- Status file also written to disk via status.mjs

### 3. Worker Processing (Redis → Orchestrator → Scripts)

```
Worker listens on 'bull:astro-build' queue (via Redis connection)
       ↓
Job received: deploy-staging
       ↓
markStarted(target) → status file: lastStartedAt, lastStatus='running'
       ↓
runCommand('bash', ['/astro-site/deploy-to-staging.sh'])
  - Sets: MODE=development, BACKUP_TARGET=staging, BACKUP_SOURCE_DIR=/shared/static/staging
  - Runs: npm install → backup previous build → npm run build:site
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
- Read: Current job state, check for followup flag
- Write: Job status transitions (active → completed/failed)
- Delete: Followup flag if present
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
  -H "Authorization: Bearer Ebulient\ Hippopotami\ Bounce\ Pleasantly" \
  -H "Content-Type: application/json" \
  -d '{"target":"staging","source":"manual"}'

# Response:
# {"status":"queued","target":"staging","source":"manual"}
```

### Check Status

```bash
curl http://localhost:4011/status \
  -H "Authorization: Bearer Ebulient\ Hippopotami\ Bounce\ Pleasantly"

# Response:
# {"status":"running","target":"staging","started":1777207930000,...}
```

### Check Health

```bash
curl http://localhost:4011/health \
  -H "Authorization: Bearer Ebulient\ Hippopotami\ Bounce\ Pleasantly"

# Response: {"status":"ok"}
```

### Environment Variables

| Variable | Default | Notes |
|----------|---------|-------|
| `ORCHESTRATOR_PORT` | 4011 | HTTP server port |
| `ASTRO_BUILD_TRIGGER_SECRET` | (none) | Bearer token for auth |
| `REDIS_URL` | redis://redis:6379 | BullMQ queue backend |
| `BUILD_QUEUE_NAME` | astro-build | BullMQ queue name |
| `BUILD_DEBOUNCE_SECONDS` | 120 | Delay for save-triggered builds |
| `WP_SAVE_TRIGGER_QUEUE_ENABLED` | 0 | Allow save-triggered builds (set to '1') |
| `MAX_BACKUPS` | 12 | Archive cleanup threshold |
| `DEV_BUILD_PATH` | (none) | Output path for dev builds |
| `STAGING_BUILD_PATH` | (none) | Output path for staging builds |
| `PRODUCTION_BUILD_PATH` | (none) | Output path for production builds |
| `ASTRO_SITE_ROOT` | /astro-site | Astro source directory |
| `ASTRO_DEPLOYMENT_STATUS_FILE` | (none) | Override status file path |

### Example Docker Exec

```bash
# Trigger staging build
docker exec deploy-orchestrator sh -c "curl -s -X POST http://localhost:4011/trigger \
  -H 'Authorization: Bearer $ASTRO_BUILD_TRIGGER_SECRET' \
  -H 'Content-Type: application/json' \
  -d '{\"target\":\"staging\"}'"

# Watch logs
docker logs -f deploy-orchestrator
```

## Edge Cases & Caveats

### 1. Production Save-Trigger Disabled

**Caveat:** `source:'save'` with `target:'production'` returns 403 Forbidden.

**Why:** Prevents accidental deploys to production from WordPress saves. Only manual triggers (via dashboard or API) are allowed.

**Workaround:** Use `source:'manual'` or wire a separate approval workflow before triggering.

### 2. Failed Jobs Don't Auto-Retry

**Caveat:** If a deploy script exits non-zero, the job is marked failed in Redis and won't auto-retry.

**Why:** Prevents resource exhaustion from looping failures. Operator must investigate root cause and manually trigger new build.

**Check:** `curl /status` shows `lastStatus:'failed'` and `lastError` with exit code.

### 3. Concurrent Triggers on Same Target

**Caveat:** If a build for staging is running and another trigger arrives, it's queued as "followup".

**Behavior:**
- First trigger starts job immediately
- Second trigger sets Redis flag `build:astro:followup:staging = '1'` and returns `status:'queued_followup'`
- After first job completes, orchestrator checks flag and enqueues one more run
- This coalesces multiple concurrent requests into 2 runs (current + 1 followup)

**Why:** Prevents queue explosion if WordPress plugin fires multiple saves quickly. Followup carries `source:'followup'` instead of 'save' or 'manual'.

### 4. Job State Cleanup

**Caveat:** Jobs in `failed` or `completed` state are removed before re-enqueueing with same jobId.

**Why:** BullMQ requires unique job IDs. If a job with ID `deploy-staging` exists in any final state (failed/completed), a new job can't be added with that ID.

**Behavior:** On second trigger for staging, if previous job failed, old job is deleted and new one created.

### 5. Max Backups Cleanup

**Caveat:** Archive files older than `MAX_BACKUPS` are deleted **on disk** after each successful build.

**Why:** Zip files accumulate and can exhaust storage. Cleanup ensures only N most recent builds retained.

**Timing:** Cleanup runs after script succeeds and archive is discovered, but before status is marked done.

**Data Loss Risk:** If cleanup threshold is very low (e.g., 1), only the current build remains on disk. No historical backups for recovery.

### 6. Save-Trigger Debounce

**Caveat:** If `source:'save'` (debounced), job is delayed by `BUILD_DEBOUNCE_SECONDS` (default 120s).

**Why:** Prevents rapid deployment from multiple consecutive WordPress saves. Groups saves into single build.

**Behavior:**
```
Save 1 → Job enqueued with delay=120s
Save 2 → Job exists in 'delayed' state → Remove old, add new (resetting delay)
Save 3 (after 100s) → Same, delay reset again
...
After 120s of no new saves → Job executes
```

**Caveat:** If save triggers and manual trigger arrives, manual is immediate (delay=0) but deploy scripts serialize (concurrency=1), so they run sequentially anyway.

### 7. Status File Schema

**Caveat:** Status file has nested structure per environment (`envs.dev`, `envs.staging`, `envs.production`).

**Why:** Allows independent tracking of three targets without mixing state.

**Note:** `updateStatus()` handles normalization. Manual edits to status file may cause schema mismatches if not careful.

**Backup Tracking:** `backups[]` array limited to 12 entries (or `MAX_BACKUPS`) in memory. Older entries dropped. Actual disk files cleaned separately by `cleanupOldArchives()`.

### 8. Script Environment Variables

**Caveat:** Deploy scripts receive env vars from orchestrator:
- `MODE=development` (for dev) or `staging` or `production`
- `BACKUP_TARGET=dev|staging|production`
- `BACKUP_SOURCE_DIR=/shared/static/{env}`
- `ASTRO_BUILD_BACKUP=1`

**Why:** Scripts need to know which environment to deploy and where to back up from/to.

**Important:** Scripts source these but also set their own (e.g., `DEV_BUILD_PATH`). Mismatch can cause builds to fail silently (wrong output path, backup skipped).

### 9. Worker Concurrency = 1

**Caveat:** Only one build runs at a time across all targets.

**Why:** Shared infrastructure (npm cache, build cache, file I/O) can't handle parallel builds safely.

**Implication:** If dev starts, staging trigger queues. Once dev finishes, staging runs. Max latency ≈ longest build duration (typically 20-60s per env).

### 10. Redis Persistence

**Caveat:** If Redis container restarts, queue is lost (assuming no snapshot taken).

**Why:** Redis running in-memory by default in compose setup.

**Workaround:** Configure Redis persistence (`RDB` snapshots or `AOF` logs) if durability critical. Orchestrator will continue accepting triggers but jobs already queued will be lost.

### 11. Status File Doesn't Auto-Sync to WordPress

**Caveat:** Orchestrator writes status file to disk. WordPress plugin must read it.

**Why:** No built-in webhook/polling from orchestrator to WordPress.

**Workaround:** WordPress plugin polls `/status` endpoint or reads status file directly (if mounted).

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

# Check followup flag
GET "build:astro:followup:staging"
```

## Troubleshooting

**Jobs stuck in waiting state:**
- Check Redis connection: `docker logs deploy-orchestrator | grep "redis"`
- Verify concurrency=1 worker is active: `docker logs deploy-orchestrator | grep "worker:completed"`

**Build fails with exit code 15:**
- Check deploy script permissions and env vars
- Verify `STAGING_BUILD_PATH` exists: `docker exec astro ls -la /shared/static/staging`

**Archive cleanup isn't running:**
- Check `MAX_BACKUPS` env var is set
- Verify archives directory exists: `docker exec deploy-orchestrator ls -la /astro-site/build-archives/`

**Status file not updating:**
- Check orchestrator has write permissions to `build-archives/`
- Verify job marked as done: `docker logs deploy-orchestrator | grep "deployment completed"`

**Production save-trigger returns 403:**
- This is expected/intentional. Use manual trigger instead.
- Set `WP_SAVE_TRIGGER_QUEUE_ENABLED=1` in env if needed (dev/staging only).
