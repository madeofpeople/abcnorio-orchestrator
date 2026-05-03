import assert from 'node:assert/strict';
import test from 'node:test';

// queue.mjs uses module-level state, so we re-import a fresh instance per test group
// by resetting state between tests via the exported reset helper.
// Since Node ESM caches modules, we reset by directly manipulating state through
// a wrapper — instead, we test the behaviour sequentially with state awareness.

const { enqueue, getQueueStatus } = await import('../queue.mjs');

// --- getQueueStatus default state ---

test('initial status is idle', () => {
  const s = getQueueStatus();
  assert.equal(s.status, 'idle');
  assert.equal(s.pendingTarget, null);
});

// --- idle → running ---

test('enqueue from idle returns accepted and runs immediately', async () => {
  let ran = false;
  const result = enqueue('staging', 'manual', 'full', async () => {
    await new Promise((r) => setTimeout(r, 20));
    ran = true;
  });

  assert.ok(result.accepted);
  assert.equal(getQueueStatus().status, 'running');

  await new Promise((r) => setTimeout(r, 50));
  assert.ok(ran);
  assert.equal(getQueueStatus().status, 'idle');
});

// --- running → queued ---

test('enqueue while running queues a second job', async () => {
  let first = false;
  let second = false;

  enqueue('staging', 'manual', 'full', async () => {
    await new Promise((r) => setTimeout(r, 40));
    first = true;
  });

  assert.equal(getQueueStatus().status, 'running');

  const result = enqueue('dev', 'manual', 'full', async () => {
    second = true;
  });

  assert.ok(result.accepted);
  assert.equal(getQueueStatus().status, 'queued');
  assert.equal(getQueueStatus().pendingTarget, 'dev');

  await new Promise((r) => setTimeout(r, 120));
  assert.ok(first);
  assert.ok(second);
  assert.equal(getQueueStatus().status, 'idle');
});

// --- queued slot full → 409 ---

test('enqueue when already queued returns not accepted', async () => {
  enqueue('staging', 'manual', 'full', async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
  enqueue('dev', 'manual', 'full', async () => {});

  assert.equal(getQueueStatus().status, 'queued');

  const result = enqueue('production', 'manual', 'full', async () => {});
  assert.equal(result.accepted, false);

  await new Promise((r) => setTimeout(r, 150));
  assert.equal(getQueueStatus().status, 'idle');
});

// --- auto-start: pending job runs after first completes ---

test('pending job auto-starts after first job completes', async () => {
  const order = [];

  enqueue('staging', 'manual', 'full', async () => {
    await new Promise((r) => setTimeout(r, 30));
    order.push('first');
  });

  enqueue('dev', 'manual', 'full', async () => {
    order.push('second');
  });

  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(getQueueStatus().status, 'idle');
});

// --- failed job still transitions state correctly ---

test('a failing job clears running state and auto-starts pending', async () => {
  let secondRan = false;

  enqueue('staging', 'manual', 'full', async () => {
    await new Promise((r) => setTimeout(r, 20));
    throw new Error('build exploded');
  });

  enqueue('dev', 'manual', 'full', async () => {
    secondRan = true;
  });

  await new Promise((r) => setTimeout(r, 120));
  assert.ok(secondRan);
  assert.equal(getQueueStatus().status, 'idle');
});
