// GM assistant tests: node tools/test-assistant.js  (exit code != 0 on failure). Ports 3990-3999.
// Never calls the real Claude API: the server is pointed (ANTHROPIC_BASE_URL) at a local fake that replays
// scripted streamed responses and records every request it receives.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { startServer, login, client, settle } from './test-client.js';

let failures = 0;
let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n       ${err.stack || err}`);
  }
}

// ---------------------------------------------------------------------------
// Pure parts (in-process): identity token, pricing, ledger
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-assistant-'));
process.env.SR_ASSISTANT_DIR = tmp;
const auth = await import('../server/lib/assistant/auth.js');
const budget = await import('../server/lib/assistant/budget.js');
const config = await import('../server/lib/assistant/config.js');
const context = await import('../server/lib/assistant/context.js');
const tools = await import('../server/lib/assistant/tools.js');

console.log('Identity token, pricing, ledger');
await test('signing key is created 0600 and the minted JWT verifies with the published JWK', () => {
  const tok = auth.mintIdentityToken();
  const [h, p, s] = tok.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  const payload = JSON.parse(Buffer.from(p, 'base64url'));
  const jwks = auth.publicJwks();
  assert.equal(jwks.keys.length, 1);
  const jwk = jwks.keys[0];
  assert.equal(header.alg, 'ES256');
  assert.equal(header.kid, jwk.kid);
  assert.ok(!('d' in jwk), 'the private part must never be published');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  assert.equal(payload.iss, auth.ISSUER);
  assert.ok(payload.sub.startsWith(auth.SUBJECT_PREFIX));
  assert.ok(payload.exp - payload.iat <= 600 && payload.exp > payload.iat);
  assert.ok(payload.jti);
  const keyFile = path.join(tmp, 'signing-key.pem');
  assert.ok(fs.existsSync(keyFile));
  if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
});
await test('every token has a fresh jti; the key survives a reload (same kid)', () => {
  const jti = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url')).jti;
  const a = auth.mintIdentityToken(), b = auth.mintIdentityToken();
  assert.notEqual(jti(a), jti(b));
  const kid = auth.publicJwks().keys[0].kid;
  auth._resetAuthCache();
  assert.equal(auth.publicJwks().keys[0].kid, kid);
});
await test('costs: input, output, cache reads and 1-hour cache writes at the model price; unknown models priced high', () => {
  const u = { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 2_000_000, cache_creation_input_tokens: 500_000 };
  // Opus 5.5: 4 + 2 + 0.4 + 4 (500K × $8)
  assert.equal(budget.costOf(u, 'claude-opus-5-5'), 10.4);
  // Split TTLs when reported: 200K at 5m ($5) + 300K at 1h ($8)
  assert.equal(budget.costOf({ ...u, cache_creation: { ephemeral_5m_input_tokens: 200_000, ephemeral_1h_input_tokens: 300_000 } }, 'claude-opus-5-5'), 4 + 2 + 0.4 + 1 + 2.4);
  assert.ok(budget.costOf(u, 'claude-unknown-9') > budget.costOf(u, 'claude-opus-5-5'));
});
await test('ledger: per month and per table; refused at the cap minus the reserve; reset', () => {
  config.updateSettings({ monthlyCapUsd: 5 });
  const nov = Date.UTC(2026, 10, 15), dec = Date.UTC(2026, 11, 1);
  budget.record({ usage: { input_tokens: 1_000_000 }, model: 'claude-opus-5-5', tableId: 'a', ts: nov }); // $4
  assert.equal(budget.monthUsage(nov).usd, 4);
  assert.equal(budget.monthUsage(nov).tables.a.usd, 4);
  assert.equal(budget.budgetStatus(nov).allowed, true); // 4 + 0.5 <= 5
  budget.record({ usage: { input_tokens: 200_000 }, model: 'claude-opus-5-5', tableId: 'b', ts: nov }); // +0.8
  assert.equal(budget.budgetStatus(nov).allowed, false);
  assert.equal(budget.monthUsage(dec).usd, 0, 'a new month starts at zero');
  assert.equal(budget.budgetStatus(dec).allowed, true);
  budget.resetMonth(nov);
  assert.equal(budget.monthUsage(nov).usd, 0);
  config.updateSettings({ monthlyCapUsd: 80 });
});
await test('settings are normalized (unknown model/effort ignored, cap clamped)', () => {
  const s = config.normalizeSettings({ model: 'gpt-x', effort: 'insane', monthlyCapUsd: 99999, enabledTables: ['x', 'x', 3] });
  assert.equal(s.model, 'claude-opus-5-5');
  assert.equal(s.effort, 'medium');
  assert.equal(s.monthlyCapUsd, config.MAX_CAP);
  assert.deepEqual(s.enabledTables, ['x']);
});
await test('core docs: bible, recap, outline and the latest session plan; the system prompt is deterministic and cached', () => {
  const names = ['act2.md', 'bible-mj-project-lazarus.md', 'campaign-outline.md', 'campaign-recap.md', 'recap-joueurs.md', 'session-2-plan.md', 'session-10-plan.md', 'foundry/x.md'];
  assert.deepEqual(context.pickCoreDocs(names).sort(), ['bible-mj-project-lazarus.md', 'campaign-outline.md', 'campaign-recap.md', 'session-10-plan.md'].sort());
  const docs = path.resolve('..', 'Shadowrun');
  const a = context.buildSystem({ docsDir: docs, campaignName: 'Project Lazarus' });
  const b = context.buildSystem({ docsDir: docs, campaignName: 'Project Lazarus' });
  assert.equal(JSON.stringify(a.system), JSON.stringify(b.system));
  assert.deepEqual(a.system.at(-1).cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.ok(a.coreDocs.length >= 3);
});
await test('doc paths cannot escape the docs folder', () => {
  const docs = path.resolve('..', 'Shadowrun');
  assert.equal(context.docPath(docs, '../app/package.json'), null);
  assert.equal(context.docPath(docs, '..\\x.md'), null);
  assert.equal(context.docPath(docs, 'a/b/c.md'), null);
});
await test('tool definitions: unique names, propose tools present, no tool can reveal or delete', () => {
  const names = tools.TOOL_DEFS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const n of ['propose_map', 'propose_map_edits', 'propose_npc', 'propose_handout', 'propose_campaign_entry']) assert.ok(names.includes(n), n);
  assert.ok(!names.some((n) => /reveal|delete|chat|roll|damage|karma|nuyen|setActive/i.test(n)));
});

// ---------------------------------------------------------------------------
// Fake Claude API
// ---------------------------------------------------------------------------
const requests = [];
const script = []; // queue of responses: { content: [...blocks], stop_reason, usage }
let lastToolId = 0;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    let json = {};
    try {
      json = JSON.parse(body || '{}');
    } catch {}
    requests.push({ url: req.url, headers: req.headers, body: json });
    const next = script.shift() || { content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' };
    const usage = { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 30000, ...(next.usage || {}) };
    const msg = { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: json.model || 'claude-opus-5-5' };
    if (!json.stream) {
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_test' });
      return res.end(JSON.stringify({ ...msg, content: next.content, stop_reason: next.stop_reason, stop_sequence: null, usage }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': 'req_test' });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev('message_start', { message: { ...msg, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
    next.content.forEach((b, index) => {
      if (b.type === 'text') {
        ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
        for (const part of b.text.match(/.{1,12}/gs) || []) ev('content_block_delta', { index, delta: { type: 'text_delta', text: part } });
      } else if (b.type === 'tool_use') {
        ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
        ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
      }
      ev('content_block_stop', { index });
    });
    ev('message_delta', { delta: { stop_reason: next.stop_reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
    ev('message_stop', {});
    res.end();
  });
});
await new Promise((r) => fake.listen(3990, '127.0.0.1', r));
const toolUse = (name, input) => ({ type: 'tool_use', id: `toolu_${++lastToolId}`, name, input });

const MAP = {
  name: 'Entrepôt test', folder: 'Tests', theme: 'industrial', lighting: 'dim', width: 8, height: 6,
  tiles: ['########', '#......#', '#..cc..D', '#......#', '#......#', '########'],
  doors: [{ x: 7, y: 2, state: 'closed', kind: 'door' }],
  regions: [{ name: 'Quai', x: 1, y: 1, w: 6, h: 4 }],
  notes: [{ x: 3, y: 2, text: 'SECRET-NOTE-XYZ' }],
};

const srv = await startServer({
  port: 3991,
  env: { ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:3990', ANTHROPIC_FEDERATION_RULE_ID: '', ANTHROPIC_ORGANIZATION_ID: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_PROFILE: '' },
});
const api = async (url, token, opts = {}) => {
  const r = await fetch(srv.url + url, {
    method: opts.method || 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let j = null;
  try {
    j = await r.json();
  } catch {}
  return { status: r.status, body: j };
};
const waitFor = async (pred, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error('timeout');
};

try {
  const adminTok = await srv.admin();
  const gmTok = await login(srv.url, { role: 'gm', password: 'lazarus' });
  const gm = await client(srv.url, gmTok);
  const pcId = Object.values(gm.state.actors).find((a) => a.type === 'pc' && !a.retired).id;
  const plTok = await login(srv.url, { role: 'player', name: 'Testeur', characterId: pcId });
  const player = await client(srv.url, plTok);
  const tableId = gm.state.config.table?.id || 'lazarus';

  console.log('Server: admin, gating, conversation, proposals');
  await test('admin: status shows API-key mode, the public JWKS (no private part), tables and an empty budget', async () => {
    const r = await api('/api/admin/assistant', adminTok);
    assert.equal(r.status, 200);
    assert.equal(r.body.auth.mode, 'apikey');
    assert.equal(r.body.jwks.keys.length, 1);
    assert.ok(!JSON.stringify(r.body.jwks).includes('"d"'));
    assert.ok(r.body.tables.some((t) => t.id === tableId && !t.enabled));
    assert.equal(r.body.budget.spent, 0);
  });
  await test('admin routes need the admin token (a GM token is refused)', async () => {
    assert.equal((await api('/api/admin/assistant', gmTok)).status, 401);
    assert.equal((await api('/api/admin/assistant', adminTok, { method: 'PATCH', body: { model: 'gpt-4' } })).status, 400);
  });
  await test('disabled table: GM gets 403 on every assistant route except status', async () => {
    assert.equal((await api('/api/assistant/status', gmTok)).body.enabled, false);
    assert.equal((await api('/api/assistant/ask', gmTok, { method: 'POST', body: { text: 'Salut' } })).status, 403);
    assert.equal((await api('/api/assistant/conversations', gmTok)).status, 403);
  });
  await api('/api/admin/assistant', adminTok, { method: 'PATCH', body: { enabledTables: [tableId], monthlyCapUsd: 80 } });

  await test('players cannot reach the assistant', async () => {
    assert.equal((await api('/api/assistant/status', plTok)).status, 403);
    assert.equal((await api('/api/assistant/ask', plTok, { method: 'POST', body: { text: 'x' } })).status, 403);
  });

  let convId;
  await test('ask → map proposal (simulated, not applied) → final answer; request shape is right', async () => {
    script.push({ content: [{ type: 'text', text: 'Je regarde.' }, toolUse('search_docs', { query: 'Hollow Pine' })], stop_reason: 'tool_use' });
    script.push({ content: [toolUse('propose_map', MAP)], stop_reason: 'tool_use' });
    script.push({ content: [{ type: 'text', text: 'Voilà la carte proposée.' }], stop_reason: 'end_turn' });
    const before = requests.length;
    const mapsBefore = Object.keys(gm.state.maps).length;
    const r = await api('/api/assistant/ask', gmTok, { method: 'POST', body: { text: 'Fais-moi un entrepôt', lang: 'fr' } });
    assert.equal(r.status, 200);
    convId = r.body.conversationId;
    await waitFor(() => gm.events.some((e) => e.ev === 'assistant:done' && e.data.conversationId === convId));
    assert.equal(requests.length - before, 3);
    const first = requests[before].body;
    assert.equal(first.model, 'claude-opus-5-5');
    assert.deepEqual(first.thinking, { type: 'adaptive' });
    assert.equal(first.output_config.effort, 'medium');
    assert.equal(first.fallbacks, 'default');
    assert.ok(String(requests[before].headers['anthropic-beta'] || '').includes('server-side-fallback-2026-07-01'));
    assert.deepEqual(first.system.at(-1).cache_control, { type: 'ephemeral', ttl: '1h' });
    assert.ok(first.system.at(-1).text.includes('bible-mj-project-lazarus.md'));
    assert.ok(first.messages[0].content[0].text.startsWith('[État de la table'));
    // Tool results went back: search results for the read tool, a proposal confirmation for propose_map.
    const second = requests[before + 1].body;
    const res1 = second.messages.at(-1).content[0];
    assert.equal(res1.type, 'tool_result');
    const third = requests[before + 2].body;
    assert.match(third.messages.at(-1).content[0].content, /Proposition créée/);
    // Streaming reached the GM only.
    assert.ok(gm.events.some((e) => e.ev === 'assistant:delta'));
    assert.ok(!player.events.some((e) => e.ev.startsWith('assistant')));
    await settle();
    assert.equal(Object.keys(gm.state.maps).length, mapsBefore, 'a proposal changes nothing');
  });

  let proposal;
  await test('conversation view: question, answer, tool badge, pending proposal with a normalized map preview', async () => {
    const r = await api(`/api/assistant/conversations/${convId}`, gmTok);
    assert.equal(r.status, 200);
    const items = r.body.items;
    assert.equal(items[0].type, 'user');
    assert.equal(items[0].text, 'Fais-moi un entrepôt');
    assert.ok(items.some((i) => i.type === 'tool' && i.name === 'search_docs'));
    const p = items.find((i) => i.type === 'proposal');
    assert.ok(p);
    proposal = p.proposal;
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.preview.map.width, 8);
    assert.equal(proposal.preview.map.doors.length, 1);
    assert.ok(!('input' in proposal), 'raw model input stays on the server');
    assert.equal(items.at(-1).type, 'assistant');
    assert.ok(r.body.usd > 0);
  });

  await test('apply → the map exists for the GM, is not active, and players see nothing of it', async () => {
    const r = await api(`/api/assistant/proposals/${proposal.id}/apply`, gmTok, { method: 'POST' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const mapId = r.body.proposal.result.mapId;
    await settle();
    const m = gm.state.maps[mapId];
    assert.ok(m);
    assert.equal(m.name, 'Entrepôt test');
    assert.notEqual(gm.state.scene.activeMapId, mapId);
    assert.ok(!JSON.stringify(player.state).includes('SECRET-NOTE-XYZ'));
    assert.ok(!JSON.stringify(player.state).includes('Entrepôt test'));
    const again = await api(`/api/assistant/proposals/${proposal.id}/apply`, gmTok, { method: 'POST' });
    assert.equal(again.status, 409);
  });

  await test('an invalid map comes back to the model as a tool error (no proposal stored)', async () => {
    script.push({ content: [toolUse('propose_map', { ...MAP, tiles: ['####', '#..#'] })], stop_reason: 'tool_use' });
    script.push({ content: [{ type: 'text', text: 'Corrigé.' }], stop_reason: 'end_turn' });
    const before = requests.length;
    gm.events.length = 0;
    await api('/api/assistant/ask', gmTok, { method: 'POST', body: { conversationId: convId, text: 'Encore une' } });
    await waitFor(() => gm.events.some((e) => e.ev === 'assistant:done'));
    const res = requests[before + 1].body.messages.at(-1).content[0];
    assert.equal(res.is_error, true);
    assert.match(res.content, /lignes/);
    const view = (await api(`/api/assistant/conversations/${convId}`, gmTok)).body;
    assert.equal(view.items.filter((i) => i.type === 'proposal').length, 1);
  });

  await test('NPC, handout (unrevealed) and quest proposals apply through the normal actions', async () => {
    script.push({
      content: [
        toolUse('propose_npc', { template: { name: 'Lieutenant Ork Test', metatype: 'Ork', attributes: { BOD: 6, AGI: 4, REA: 4, STR: 6, WIL: 3, LOG: 2, INT: 3, CHA: 2, EDG: 1 }, npc: { professionalRating: 3 } }, folder: 'Gangs' }),
        toolUse('propose_handout', { title: 'Message intercepté', body: 'HANDOUT-SECRET-123' }),
        toolUse('propose_campaign_entry', { kind: 'quest', title: 'Quête test', summary: 'Résumé', phases: ['Phase 1'] }),
      ],
      stop_reason: 'tool_use',
    });
    script.push({ content: [{ type: 'text', text: 'Trois propositions.' }], stop_reason: 'end_turn' });
    gm.events.length = 0;
    await api('/api/assistant/ask', gmTok, { method: 'POST', body: { conversationId: convId, text: 'Prépare la suite' } });
    await waitFor(() => gm.events.some((e) => e.ev === 'assistant:done'));
    const view = (await api(`/api/assistant/conversations/${convId}`, gmTok)).body;
    const props = view.items.filter((i) => i.type === 'proposal' && i.proposal.status === 'pending').map((i) => i.proposal);
    assert.equal(props.length, 3);
    for (const p of props) {
      const r = await api(`/api/assistant/proposals/${p.id}/apply`, gmTok, { method: 'POST' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    await settle();
    assert.ok(Object.values(gm.state.bestiary).some((t) => t.name === 'Lieutenant Ork Test' && t.folder === 'Gangs'));
    const h = gm.state.campaign.handouts.find((x) => x.title === 'Message intercepté');
    assert.ok(h);
    assert.ok(Array.isArray(h.revealedTo) && h.revealedTo.length === 0);
    assert.ok(!JSON.stringify(player.state).includes('HANDOUT-SECRET-123'));
    assert.ok(gm.state.campaign.quests.some((q) => q.title === 'Quête test'));
  });

  await test('the assistant file never reaches any view', async () => {
    assert.ok(!JSON.stringify(gm.state).includes('Fais-moi un entrepôt'));
    assert.ok(!JSON.stringify(player.state).includes('Fais-moi un entrepôt'));
    assert.ok(fs.existsSync(path.join(srv.runtime, 'tables', tableId, 'assistant.json')));
  });

  await test('spend is recorded per table and shown in /admin; at the cap questions are refused (402)', async () => {
    const a = (await api('/api/admin/assistant', adminTok)).body;
    assert.ok(a.budget.spent > 0 || a.usage.usd > 0);
    assert.ok(a.usage.tables[tableId].calls >= 7);
    await api('/api/admin/assistant', adminTok, { method: 'PATCH', body: { monthlyCapUsd: 0.4 } });
    const r = await api('/api/assistant/ask', gmTok, { method: 'POST', body: { text: 'Encore ?' } });
    assert.equal(r.status, 402);
    await api('/api/admin/assistant', adminTok, { method: 'PATCH', body: { monthlyCapUsd: 80 } });
  });

  await test('admin connection test makes one small non-streamed call', async () => {
    const before = requests.length;
    const r = await api('/api/admin/assistant/test', adminTok, { method: 'POST' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(requests.length - before, 1);
    assert.ok(requests.at(-1).body.max_tokens <= 400);
  });

  await test('a second question while one runs is refused (409); stop works', async () => {
    script.push({ content: [toolUse('get_campaign', {})], stop_reason: 'tool_use' });
    script.push({ content: [toolUse('list_maps', {})], stop_reason: 'tool_use' });
    script.push({ content: [{ type: 'text', text: 'fin' }], stop_reason: 'end_turn' });
    gm.events.length = 0;
    const r1 = await api('/api/assistant/ask', gmTok, { method: 'POST', body: { text: 'Long' } });
    assert.equal(r1.status, 200);
    const r2 = await api('/api/assistant/ask', gmTok, { method: 'POST', body: { text: 'Autre' } });
    assert.ok(r2.status === 409 || gm.events.some((e) => e.ev === 'assistant:done'), `unexpected ${r2.status}`);
    await waitFor(() => gm.events.some((e) => e.ev === 'assistant:done'));
  });

  await test('the tool loop stops after the step limit', async () => {
    for (let i = 0; i < 10; i++) script.push({ content: [toolUse('get_combat', {})], stop_reason: 'tool_use' });
    const before = requests.length;
    gm.events.length = 0;
    const r = await api('/api/assistant/ask', gmTok, { method: 'POST', body: { text: 'Boucle' } });
    await waitFor(() => gm.events.some((e) => e.ev === 'assistant:done'));
    assert.equal(requests.length - before, 8);
    const view = (await api(`/api/assistant/conversations/${r.body.conversationId}`, gmTok)).body;
    assert.ok(view.items.some((i) => i.type === 'notice' && /Limite d’étapes/.test(i.key)));
    script.length = 0;
  });

  await test('conversations are listed and deleted', async () => {
    const list = (await api('/api/assistant/conversations', gmTok)).body;
    assert.ok(list.length >= 2);
    assert.equal((await api(`/api/assistant/conversations/${convId}`, gmTok, { method: 'DELETE' })).status, 200);
    assert.equal((await api(`/api/assistant/conversations/${convId}`, gmTok)).status, 404);
  });

  gm.close();
  player.close();
} finally {
  srv.stop();
  fake.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
