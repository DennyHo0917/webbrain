import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const html = `<!doctype html><html><head><title>Invoice 103</title><link rel="canonical" href="/invoices/103"></head><body>
<section data-record-id="103"><h1>Invoice 103</h1><form><textarea name="reminder">Invoice 103 is due.</textarea>
<input type="password" name="password" value="never-copy-this-password"><button type="submit">Send reminder</button></form>
<p id="receipt"></p></section><script>window.sentCount=0;document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();window.sentCount++;document.querySelector('#receipt').textContent='Reminder sent for invoice 103. Receipt reminder-103-'+window.sentCount;});</script></body></html>`;
const server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/invoices/103`);
  for (const name of ['chrome', 'firefox']) {
    const { BotMemorySession, observeMemoryPageInPage, observeBotMemoryPage } = await import(`../src/${name}/src/agent/bot-memory.js`);
    const { Agent } = await import(`../src/${name}/src/agent/agent.js`);
    const api = { tabs: { get: async () => ({ url: page.url(), title: await page.title() }) },
      scripting: { executeScript: async ({ args }) => [{ result: await page.evaluate(observeMemoryPageInPage, args[0]), frameId: 0 }] } };
    globalThis.chrome = { ...api, storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async () => ({}), set: async () => {} } },
      runtime: { getURL: value => `chrome-extension://test/${value}`, sendMessage: async () => ({}) } };
    globalThis.browser = globalThis.chrome;
    const attempts = new Map();
    let requestCount = 0;
    const envelope = () => ({ version: 1, policyVersion: 1, botId: 'bot-' + name, runId: 'run-' + name,
      callbackUrl: `http://127.0.0.1:${port}/api/internal/bot-memory/run-${name}`, callbackToken: 'local-test-only-token'.repeat(3),
      policy: { schemaVersion: 1, summary: 'Send one reminder for each invoice.', timezone: 'UTC', confidence: 1,
        actions: [{ key: 'remind', label: 'Send reminder', target: 'Invoice', effect: 'write', repeat: { mode: 'unique' }, evidenceFields: ['receipt'] }] }, context: {} });
    const fetchImpl = async (_url, options) => {
      const { operation, args } = JSON.parse(options.body);
      assert.ok(!options.body.includes('never-copy-this-password'), 'DOM drafts never include password values');
      if (operation === 'prepare') {
        assert.equal(args.observation.elementFacts.label, 'Send reminder');
        assert.equal(args.observation.elementFacts.draftText, 'Invoice 103 is due.');
        assert.ok(args.observation.targets.some(target => target.kind === 'id' && target.id === '103'), 'Stable ID comes from actual DOM');
        if (attempts.size) return Response.json({ allowed: false, reason: 'duplicate' });
        const attempt = { id: 'attempt-' + (++requestCount), status: 'reserved', requestId: args.requestId };
        attempts.set(attempt.id, attempt);
        return Response.json({ allowed: true, reservation: { attemptId: attempt.id, requestId: args.requestId,
          actionKey: 'remind', target: args.observation.targets[0] } });
      }
      if (operation === 'dispatch') {
        const attempt = attempts.get(args.attemptId); attempt.status = 'dispatched'; return Response.json({ attempt });
      }
      if (operation === 'verify') {
        assert.match(args.evidence.facts.pageText, /Reminder sent for invoice 103/);
        const attempt = attempts.get(args.attemptId); attempt.status = 'verified'; return Response.json({ attempt });
      }
      return Response.json({ success: true });
    };
    const make = () => {
      const session = new BotMemorySession(envelope(), { fetchImpl, observe: (tab, args) => observeBotMemoryPage(tab, args, api) });
      const agent = new Agent({ getActive: () => ({ model: 'test' }) });
      agent._botMemorySessions.set(7, session);
      agent._executeToolWithLifecycle = async (_tab, tool) => {
        if (tool === 'click_ax') { await page.locator('button').click(); return { success: true }; }
        if (tool === 'read_page') return { success: true, text: await page.locator('body').innerText() };
        throw new Error('Unexpected fixture tool');
      };
      return { agent, session };
    };
    await page.reload();
    let h = make();
    const sent = await h.agent.executeTool(7, 'click_ax', { selector: 'button' });
    assert.equal(sent.success, true);
    await h.agent.executeTool(7, 'read_page', {});
    await h.session.close();
    assert.equal(await page.evaluate(() => window.sentCount), 1);
    // A fresh browser run forgets its local session, while the app ledger still
    // recognizes the same generic invoice and blocks before another click.
    h = make();
    const repeated = await h.agent.executeTool(7, 'click_ax', { selector: 'button' });
    assert.equal(repeated.noDispatch, true);
    assert.equal(repeated.error, 'duplicate');
    assert.equal(await page.evaluate(() => window.sentCount), 1);
    await h.session.close();
    console.log(`${name}: observed generic invoice, one verified reminder, repeated reminder blocked before click.`);
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
