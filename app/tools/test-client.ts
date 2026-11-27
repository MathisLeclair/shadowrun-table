// Test helper: start an isolated server and drive it over Socket.IO like a real client.
//   import { startServer, login, client } from './test-client.ts';
//   const srv = await startServer({ port: 3101 });           // fresh runtime in a temp dir: one table "lazarus" (seeds applied)
//   const gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' }));
//   const result = await gm.send('maps/moveToken', { ... });  // throws on { ok:false }
//   gm.state  -> latest view;  await gm.nextState()  -> waits for the next broadcast
//   srv.stop()
// Multi-table:
//   const srv = await startServer({ port, tables: [{ id: 'alpha', pack: 'vierge', gmPassword: 'secret-a' }, { id: 'beta' }] });
//     → those tables exist at boot (no bootstrap "lazarus" table unless `bootstrap: true`)
//   login(srv.url, { role: 'gm', password, table: 'alpha' }) ; client(srv.url, token, { table: 'alpha' })
//   const adminToken = await srv.admin();  // admin password: srv.adminPassword
//   startServer({ legacyState: {...} })     → writes <runtime>/state.json (old single-table layout) before boot
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function writeTable(runtime, t) {
  const id = t.id;
  const dir = path.join(runtime, 'tables', id);
  fs.mkdirSync(dir, { recursive: true });
  const state = t.state || { version: 1, config: { gmPassword: t.gmPassword || 'lazarus', campaignName: t.name || id, lang: t.lang || 'fr' }, users: {}, actors: {}, log: [] };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  fs.writeFileSync(path.join(dir, 'table.json'), JSON.stringify({ id, name: t.name || id, pack: t.pack || 'project-lazarus', lang: t.lang || 'fr', legacy: !!t.legacy, hidden: !!t.hidden }));
}

export async function startServer({
  port = 3100 + Math.floor(Math.random() * 800), quiet = true, env = {}, tables = null, bootstrap = undefined, legacyState = null,
  adminPassword = 'admin-test-pw', runtime: givenRuntime = null, keepRuntime = false,
} = {}) {
  const runtime = givenRuntime || fs.mkdtempSync(path.join(os.tmpdir(), 'sr-test-'));
  if (legacyState) fs.writeFileSync(path.join(runtime, 'state.json'), JSON.stringify(legacyState));
  for (const t of tables || []) writeTable(runtime, t);
  const childEnv = { ...process.env, PORT: String(port), SR_RUNTIME_DIR: runtime, SR_ADMIN_PASSWORD: adminPassword, ...env };
  if (tables && !bootstrap) childEnv.SR_BOOTSTRAP_TABLE = 'none';
  // Node runs the TypeScript server directly; before 22.18 type stripping needs a flag (no-op when NODE_OPTIONS already has it).
  const stripTypes = process.features.typescript ? [] : ['--experimental-strip-types'];
  const proc = spawn(process.execPath, [...stripTypes, 'server/index.ts'], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; if (!quiet) process.stdout.write(d); });
  proc.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
  const url = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(url + '/api/health'); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const exited = new Promise((r) => proc.once('exit', r));
  return {
    url, port, runtime, proc, adminPassword, output: () => out,
    /** Log in as server admin, returns the admin bearer token. */
    async admin(password = adminPassword) {
      const r = await fetch(url + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      return j.token;
    },
    /** Stop the process (waits for its exit); `keep` keeps the runtime dir (restart tests). */
    async stopAndWait({ keep = false } = {}) {
      proc.kill();
      await exited;
      if (!keep && !keepRuntime) try { fs.rmSync(runtime, { recursive: true, force: true }); } catch {}
    },
    stop: () => { proc.kill(); if (!keepRuntime) try { fs.rmSync(runtime, { recursive: true, force: true }); } catch {} },
  };
}

export async function login(url, body) {
  const r = await fetch(url + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j.token;
}

export function client(url, token, { table } = {}) {
  return new Promise((resolve, reject) => {
    const socket = io(url, { auth: table ? { token, table } : { token }, transports: ['websocket'] });
    const waiters = [];
    const c = {
      socket, state: null, events: [],
      send(type, payload = {}) {
        return new Promise((res, rej) => socket.emit('action', { type, payload }, (r) => (r && r.ok ? res(r.result) : rej(new Error(r ? r.error : 'no reply')))));
      },
      nextState() { return new Promise((res) => waiters.push(res)); },
      close() { socket.close(); },
    };
    socket.onAny((ev, data) => { if (ev !== 'state') c.events.push({ ev, data }); });
    socket.on('state', (s) => { c.state = s; while (waiters.length) waiters.shift()(s); });
    socket.once('state', () => resolve(c));
    socket.on('connect_error', reject);
  });
}

/** Wait for broadcasts to settle (debounced 30ms server-side). */
export const settle = (ms = 350) => new Promise((r) => setTimeout(r, ms));
