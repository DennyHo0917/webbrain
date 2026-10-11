import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const storage = {};
const api = {
  storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async key => ({ [key]: storage[key] }), set: async value => Object.assign(storage, value) } },
  runtime: { getURL: value => `chrome-extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: 'https://example.test/invoices/103', title: 'Invoice 103' }), query: async () => [{ id: 7, url: 'https://example.test/invoices/103' }], update: async () => {}, sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;
const target = { kind: 'url', url: 'https://example.test/invoices/103' };
const config = () => ({ version: 1, policyVersion: 1, botId: 'bot-1', runId: 'run-1',
  callbackUrl: 'https://app.test/api/internal/bot-memory/run-1', callbackToken: 'private-run-secret-'.repeat(4),
  policy: { schemaVersion: 1, timezone: 'UTC', summary: 'Send one invoice reminder.', confidence: 1,
    actions: [{ key: 'remind', label: 'Send reminder', target: 'Invoice', effect: 'write', repeat: { mode: 'unique' }, evidenceFields: ['delivery_confirmation'] }] }, context: { previous: [] } });
const observed = () => ({ url: target.url, title: 'Invoice 103', targets: [target], observedAt: Date.now(),
  elementFacts: { found: true, tag: 'BUTTON', type: 'submit', label: 'Send reminder', draftText: 'Invoice 103 is due.' }, text: 'Invoice 103. Send reminder.' });

for (const browser of ['chrome', 'firefox']) {
  const { BotMemorySession, normalizeTaskMemory, sanitizeMemoryArguments } = await import(`../src/${browser}/src/agent/bot-memory.js`);
  const { Agent } = await import(`../src/${browser}/src/agent/agent.js`);
  const { createCloudRunController } = await import(`../src/${browser}/src/cloud-runs.js`);
  function harness({ callbackFailure = false, duplicate = false, dispatchRejected = false, changedTarget = false } = {}) {
    const calls = [], pageActions = [];
    let reads = 0;
    const session = new BotMemorySession(config(), {
      observe: async () => { reads++; return changedTarget && reads > 1 ? { ...observed(), url: 'https://example.test/invoices/104' } : observed(); },
      fetchImpl: async (_url, options) => {
        const { operation, args } = JSON.parse(options.body);
        calls.push({ operation, args });
        assert.match(options.headers.Authorization, /^Bearer private-run-secret-/);
        if (callbackFailure) throw new Error('Leaky secret server error ' + config().callbackToken);
        if (operation === 'prepare') return Response.json(duplicate ? { allowed: false, reason: 'duplicate' } : {
          allowed: true, reservation: { attemptId: 'attempt-1', requestId: args.requestId, actionKey: 'remind', target },
        });
        if (operation === 'dispatch') return Response.json({ attempt: { id: 'attempt-1', status: dispatchRejected ? 'reserved' : 'dispatched' } });
        if (operation === 'verify') return Response.json({ attempt: { id: 'attempt-1', status: 'verified' } });
        return Response.json({ success: true });
      },
    });
    const agent = new Agent({ getActive: () => ({ model: 'test' }) });
    agent._botMemorySessions.set(7, session);
    agent._executeToolWithLifecycle = async (_tab, name) => {
      pageActions.push(name);
      assert.ok(name === 'read_page' || calls.some(call => call.operation === 'dispatch'), 'Reserve and durable dispatch must precede writes');
      return name === 'read_page' ? { success: true, text: 'Reminder sent for invoice 103.' } : { success: true };
    };
    return { agent, session, calls, pageActions };
  }

  test(`${browser}: generic action reserves before dispatch and verifies on explicit observation`, async () => {
    const h = harness();
    const action = await h.agent.executeTool(7, 'click_ax', { ref_id: 'ref_5' });
    assert.equal(action.success, true);
    assert.equal(action.memoryAttemptId, 'attempt-1');
    assert.deepEqual(h.calls.map(call => call.operation), ['prepare', 'dispatch']);
    const read = await h.agent.executeTool(7, 'read_page', {});
    assert.equal(read.success, true);
    assert.deepEqual(h.calls.map(call => call.operation), ['prepare', 'dispatch', 'verify']);
    const evidence = h.calls[2].args.evidence;
    assert.equal(evidence.source, 'runtime');
    assert.equal(evidence.confirmation, 'page_state');
    assert.match(evidence.facts.readResult, /Reminder sent/);
    assert.equal(h.session.pending.size, 0);
  });
  test(`${browser}: duplicate, unavailable callback, ambiguous dispatch and stale target all block actual page input`, async () => {
    for (const options of [{ duplicate: true }, { callbackFailure: true }, { dispatchRejected: true }, { changedTarget: true }]) {
      const h = harness(options);
      const result = await h.agent.executeTool(7, 'press_keys', { keys: ['ENTER'] });
      assert.equal(result.success, false);
      assert.equal(result.noDispatch, true);
      assert.deepEqual(h.pageActions, []);
      assert.ok(!JSON.stringify(result).includes(config().callbackToken), 'Errors never expose scoped secrets');
    }
  });
  test(`${browser}: lost tool outcomes remain uncertain even when the overall run fails`, async () => {
    const h = harness();
    h.agent._executeToolWithLifecycle = async () => { throw new Error('Browser disconnected after click'); };
    await assert.rejects(h.agent.executeTool(7, 'click_ax', { ref_id: 'ref_5' }), /disconnected/);
    assert.equal(h.session.pending.size, 1);
    await h.session.close();
    assert.equal(h.calls.at(-1).operation, 'resolve');
    assert.equal(h.calls.at(-1).args.status, 'uncertain');
    assert.equal(h.session.config.callbackToken, '');
  });
  test(`${browser}: unverified actions block successful completion, but an honest partial outcome can finish`, async () => {
    const h = harness();
    await h.agent.executeTool(7, 'click_ax', { ref_id: 'ref_5' });
    const done = await h.agent.executeTool(7, 'done', { outcome: 'success', summary: 'Sent.' });
    assert.equal(done.blockedDone, true);
    assert.match(done.error, /uncertain/);
    assert.equal((await h.agent.executeTool(7, 'done_json', { result: { complete: true } })).blockedDone, true);
    h.agent._executeToolWithLifecycle = async () => ({ done: true, outcome: 'partial', summary: 'The reminder may have sent, but its result is unverified.' });
    assert.equal((await h.agent.executeTool(7, 'done', { outcome: 'partial', summary: 'Unverified.' })).outcome, 'partial');
    await h.session.close();
    assert.equal(h.calls.at(-1).args.status, 'uncertain');
  });
  test(`${browser}: explicit no-dispatch releases reservation, read access and unprotected work remain unchanged`, async () => {
    const h = harness();
    h.agent._executeToolWithLifecycle = async () => ({ success: false, noDispatch: true, dispatched: false });
    await h.agent.executeTool(7, 'set_field', { ref_id: 'ref_5', text: 'Reminder', submit: true });
    assert.equal(h.calls.at(-1).args.status, 'failed_before_dispatch');
    assert.equal(h.session.pending.size, 0);
    h.agent._botMemorySessions.delete(7);
    let calls = 0;
    h.agent._executeToolWithLifecycle = async () => { calls++; return { success: true }; };
    assert.equal((await h.agent.executeTool(7, 'execute_js', { code: 'document.title' })).success, true);
    assert.equal(calls, 1);
  });
  test(`${browser}: protected scripts cannot bypass the guard and lookups cannot invent target identifiers`, async () => {
    const h = harness();
    assert.equal((await h.agent.executeTool(7, 'execute_js', { code: 'fetch("/send",{method:"POST"})' })).noDispatch, true);
    assert.equal((await h.agent.executeTool(7, 'bot_memory_lookup', { action_key: 'remind', target_index: 0 })).success, false);
    const targets = await h.agent.executeTool(7, 'bot_memory_observe', {});
    assert.deepEqual(targets.targets, [target]);
    await h.agent.executeTool(7, 'bot_memory_lookup', { action_key: 'remind', target_index: 0 });
    assert.equal(h.calls.at(-1).operation, 'lookup');
    assert.deepEqual(h.calls.at(-1).args.target, target);
    assert.deepEqual(h.pageActions, []);
  });
  test(`${browser}: scratchpad survives via app callback and read-record tool cannot fabricate write success`, async () => {
    const h = harness();
    h.agent._executeToolWithLifecycle = async () => ({ success: true });
    await h.agent.executeTool(7, 'scratchpad_write', { text: 'Invoice 103 needs a followup.', replace: false });
    assert.equal(h.calls.at(-1).operation, 'scratchpad');
    assert.match(h.calls.at(-1).args.text, /Invoice 103/);
    await h.agent.executeTool(7, 'bot_memory_observe', {});
    assert.equal((await h.agent.executeTool(7, 'bot_memory_record', { action_key: 'remind', target_index: 0 })).success, false);
    assert.ok(!h.calls.some(call => call.operation === 'resolve' && call.args.status === 'verified'));
  });
  test(`${browser}: callback validation and credential sanitation keep private configuration out of model context`, () => {
    assert.throws(() => normalizeTaskMemory({ ...config(), callbackUrl: 'http://remote.test/api/internal/bot-memory/run-1' }), /callback/);
    assert.throws(() => normalizeTaskMemory({ ...config(), callbackUrl: 'https://app.test/api/internal/bot-memory/wrong-run' }), /callback/);
    assert.throws(() => normalizeTaskMemory({ ...config(), policyVersion: 0 }), /configuration/);
    assert.equal(normalizeTaskMemory({ ...config(), callbackUrl: 'http://127.0.0.1:4174/api/internal/bot-memory/run-1' }).version, 1);
    const h = harness();
    assert.ok(!h.session.systemNote().includes(config().callbackToken));
    assert.ok(!h.session.systemNote().includes(config().callbackUrl));
    assert.deepEqual(sanitizeMemoryArguments({ text: 'secret-password', apiKey: 'private', ref_id: 'ref_8' }, { elementFacts: { credential: true } }),
      { text: '[credential input omitted]', ref_id: 'ref_8' });
  });
  test(`${browser}: actual Cloud model loop advertises memory tools, persists notes and clears ephemeral state`, async () => {
    const tool = (name, args) => ({ content: null, toolCalls: [{ id: 'call-' + name, function: { name, arguments: JSON.stringify(args) } }] });
    const responses = [tool('bot_memory_note', { text: 'Invoice 103 needs review.' }),
      tool('read_page', {}), tool('done', { outcome: 'success', summary: 'Invoice 103 is due.' })];
    const requests = [], callbacks = [];
    const provider = { name: 'test', model: 'test', promptTier: 'full', contextWindow: 128000,
      supportsTools: true, supportsVision: false, chat: async (messages, options) => {
        requests.push({ messages, options });
        assert.ok(responses.length);
        assert.ok(options.tools.some(tool => tool.function.name === 'bot_memory_lookup'));
        assert.match(messages[0].content, /PERSISTENT BOT MEMORY/);
        assert.ok(!JSON.stringify(messages).includes(config().callbackToken));
        return responses.shift();
      } };
    const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
    agent.maxSteps = 6;
    agent._skipPermissionGate = true;
    agent._hydrate = async () => {};
    agent._persist = () => {};
    agent._persistNow = async () => ({ ok: true });
    agent._startTraceRun = async () => null;
    agent._endTraceRun = async () => {};
    agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => ({ role: 'user', content });
    agent._manageContext = async () => {};
    agent._checkCostAllowance = async () => null;
    agent._recordCostUsage = async () => null;
    agent._currentUrl = async () => target.url;
    agent._maybeReinjectAdapter = async () => {};
    agent._ensureProgressSessionForCurrentTask = async () => ({ mode: 'inactive' });
    agent._executeToolWithLifecycle = async (_tab, name, args) => name === 'done'
      ? { done: true, summary: args.summary, outcome: args.outcome }
      : { success: true, text: 'Invoice 103 is due.' };
    const priorFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) => { callbacks.push(JSON.parse(options.body)); return Response.json({ success: true }); };
    try {
      const result = await agent.processMessage(7, 'Read this invoice and keep useful notes.', () => {}, 'act', [], { cloudRun: true, taskMemory: config() });
      assert.match(result, /Invoice 103/);
      assert.equal(requests.length, 3);
      assert.equal(callbacks[0].operation, 'scratchpad');
      assert.equal(agent._botMemorySessions.has(7), false);
    } finally { globalThis.fetch = priorFetch; }
  });
  test(`${browser}: Cloud forwards memory only in ephemeral run options and requires a fresh protected continuation`, async () => {
    const observedOptions = [];
    const agent = { isRunning: () => false, processMessage: async (_tab, _task, _update, _mode, _attachments, options) => { observedOptions.push(options); return 'Read the page.'; } };
    let id = 0;
    const controller = createCloudRunController({ chromeApi: api, agent, ensureOffscreen: async () => {}, makeRunId: () => `${browser}-cloud-${++id}` });
    const run = await controller.startRun({ task: 'Read this page.', taskMemory: config() });
    for (let i = 0; i < 50 && controller.runs.get(run.runId).status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(observedOptions[0].taskMemory.callbackToken, config().callbackToken);
    const persisted = JSON.stringify(storage);
    assert.ok(!persisted.includes(config().callbackToken));
    assert.ok(!persisted.includes(config().callbackUrl));
    const snapshot = JSON.stringify(await controller.status({ runId: run.runId }));
    assert.ok(!snapshot.includes(config().callbackToken));
    await assert.rejects(controller.startRun({ parentRunId: run.runId, task: 'Continue.' }), error => error.status === 409 && /fresh/.test(error.message));
    await assert.rejects(controller.startRun({ task: 'Replay workflow.', _workflow: { id: 'test' }, taskMemory: config() }), error => error.status === 409);
  });
}

test('browser builds share the memory contract and advertise runtime capability', async () => {
  const chrome = await readFile(new URL('../src/chrome/src/agent/bot-memory.js', import.meta.url), 'utf8');
  const firefox = await readFile(new URL('../src/firefox/src/agent/bot-memory.js', import.meta.url), 'utf8');
  assert.equal(chrome, firefox);
  for (const file of ['../src/chrome/src/offscreen/cloud-bridge.js', '../src/firefox/src/cloud-bridge.js']) {
    assert.match(await readFile(new URL(file, import.meta.url), 'utf8'), /bot_memory_v1/);
  }
});
