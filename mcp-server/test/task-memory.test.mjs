import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';

const allocator = createServer();
allocator.listen(0, '127.0.0.1');
await once(allocator, 'listening');
process.env.WEBBRAIN_BRIDGE_PORT = String(allocator.address().port);
allocator.close();
await once(allocator, 'close');
const { WebBrainBridge } = await import('../dist/bridge.js');
const { startRun, getStatus, describeSnapshot } = await import('../dist/runs.js');
const { bridgeUrl } = await import('../dist/config.js');
const { validateTaskMemory, redactTaskMemory, redactMemoryRunResponse } = await import('../dist/task-memory.js');

const memory = {
  version: 1, botId: 'bot-owned', runId: 'app-run-1', policyVersion: 1,
  callbackUrl: 'http://127.0.0.1:4174/api/internal/bot-memory/app-run-1',
  callbackToken: 'private-scoped-callback-token-for-run',
  policy: { schemaVersion: 1, actions: [{ key: 'read', effect: 'read', repeat: { mode: 'unique' } }] },
  context: { document: null, recentActions: [], totalActions: 0 },
};

test('MCP validates private callbacks and bounded envelopes without exposing supplied data', () => {
  const ordinary = { result: { callbackToken: 'ordinary requested field', taskMemory: { title: 'ordinary page content' } } };
  assert.deepEqual(redactTaskMemory(ordinary), ordinary);
  const secrets = new Set([memory.callbackToken, memory.callbackUrl]);
  assert.deepEqual(redactMemoryRunResponse({ runId: 'ordinary', ...ordinary }, secrets, new Set(['protected'])), { runId: 'ordinary', ...ordinary });
  const listed = redactMemoryRunResponse({ runs: [{ runId: 'protected', ...ordinary }, { runId: 'ordinary', ...ordinary }], taskMemory: memory }, secrets, new Set(['protected']));
  assert.equal(listed.taskMemory, undefined);
  assert.deepEqual(listed.runs[0].result, {});
  assert.deepEqual(listed.runs[1].result, ordinary.result);
  assert.equal(redactTaskMemory(JSON.stringify({ ...memory, context: { notes: 'private-diagnostic-note' } }), secrets).includes('private-diagnostic-note'), false);
  assert.deepEqual(validateTaskMemory(memory), memory);
  for (const patch of [
    { botId: undefined }, { version: 2 }, { policyVersion: 0 },
    { callbackUrl: 'http://remote.example/api/internal/bot-memory/app-run-1' },
    { callbackUrl: 'https://user:password@webbrain.me/api/internal/bot-memory/app-run-1' },
    { callbackUrl: 'http://127.0.0.1:4174/api/internal/bot-memory/another' },
    { callbackUrl: memory.callbackUrl + '?secret=secret' },
    { context: { notes: 'x'.repeat(128 * 1024) } }, { extra: 'private' },
  ]) assert.throws(() => validateTaskMemory({ ...memory, ...patch }), /^Error: Invalid task_memory envelope\.$/);
});

test('MCP rejects protected runs on old bridges before dispatch; ordinary calls are unchanged', async () => {
  const calls = [];
  const bridge = { capabilities: () => [], async request(action, payload) { calls.push({ action, payload }); return { runId: 'ordinary', status: 'running' }; } };
  await assert.rejects(startRun(bridge, { task: 'Read', mode: 'act', taskMemory: memory }), error => error.status === 409);
  assert.equal(calls.length, 0);
  await startRun(bridge, { task: 'Read', mode: 'ask' });
  assert.deepEqual(calls[0], { action: 'cloud_run', payload: { task: 'Read', mode: 'ask' } });
});

test('MCP transports memory outside prompts and redacts credentials from status and errors after failure', async () => {
  const bridge = new WebBrainBridge();
  await bridge.start();
  const seen = [];
  let rejectNext = false;
  const extension = new WebSocket(bridgeUrl());
  extension.on('open', () => extension.send(JSON.stringify({ type: 'hello', client: 'webbrain-extension', protocolVersion: 2, capabilities: ['bot_memory_v1'] })));
  extension.on('message', raw => {
    const message = JSON.parse(raw.toString());
    seen.push(message);
    const ordinary = message.action === 'cloud_run' && !message.payload.taskMemory;
    extension.send(JSON.stringify(rejectNext
      ? { id: message.id, ok: false, status: 500, error: `failed ${memory.callbackToken}` }
      : { id: message.id, ok: true, result: {
        runId: ordinary ? 'ordinary-run' : 'browser-run', status: message.action === 'cloud_status' ? 'failed' : 'running',
        taskMemory: memory, result: ordinary ? { taskMemory: { title: 'ordinary field' }, callbackToken: 'ordinary token', callbackUrl: 'https://ordinary.example' } : { text: 'read', task_memory: memory },
        error: `uncertain ${memory.callbackToken}`, updates: [{ note: memory.callbackToken, callbackToken: memory.callbackToken }],
      } }));
  });
  try {
    assert.equal(await bridge.waitForExtension(3000), true);
    const started = await startRun(bridge, { runId: 'browser-run', task: 'Read a story', mode: 'act', taskMemory: memory });
    assert.deepEqual(seen[0].payload.taskMemory, memory);
    assert.equal(seen[0].payload.task, 'Read a story');
    assert.equal(seen[0].payload.task.includes(memory.callbackToken), false);
    assert.equal(JSON.stringify(started).includes(memory.callbackToken), false);
    const failed = await getStatus(bridge, 'browser-run');
    assert.equal(failed.status, 'failed');
    assert.equal(JSON.stringify(failed).includes(memory.callbackToken), false);
    assert.equal(JSON.stringify(failed).includes('taskMemory'), false);
    assert.equal(describeSnapshot(failed).includes(memory.callbackToken), false);
    const ordinary = await startRun(bridge, { runId: 'ordinary-run', task: 'Ordinary', mode: 'ask' });
    assert.deepEqual(ordinary.result, { taskMemory: { title: 'ordinary field' }, callbackToken: 'ordinary token', callbackUrl: 'https://ordinary.example' });
    rejectNext = true;
    await assert.rejects(getStatus(bridge, 'browser-run'), error => error.status === 500 && !error.message.includes(memory.callbackToken));
  } finally { extension.close(); await bridge.stop(); }
});
