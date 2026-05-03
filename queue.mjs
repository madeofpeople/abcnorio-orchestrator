// In-memory build queue: concurrency 1, one pending slot.
// status: 'idle' | 'running' | 'queued'
// 'queued' means one job is running and one is waiting.

let status = 'idle';
let pendingJob = null;

export function getQueueStatus() {
  return { status, pendingTarget: pendingJob?.target ?? null };
}

// Returns { accepted: true } on 202, { accepted: false } on 409.
export function enqueue(target, source, scope, fn) {
  if (status === 'idle') {
    status = 'running';
    _run(target, source, scope, fn);
    return { accepted: true };
  }
  if (pendingJob !== null) {
    return { accepted: false };
  }
  pendingJob = { target, source, scope, fn };
  status = 'queued';
  return { accepted: true };
}

async function _run(target, source, scope, fn) {
  try {
    await fn(target, source, scope);
  } catch {
    // errors are handled inside fn via setRuntimeState/markFailed
  } finally {
    const next = pendingJob;
    pendingJob = null;
    if (next) {
      status = 'running';
      _run(next.target, next.source, next.scope, next.fn);
    } else {
      status = 'idle';
    }
  }
}
