// Test helper: start an isolated server and drive it over Socket.IO like a real client.
//   import { startServer, login, client } from './test-client.js';
//   const srv = await startServer({ port: 3101 });           // fresh state in a temp dir (seeds applied)
//   const gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' }));
//   const result = await gm.send('maps/moveToken', { ... });  // throws on { ok:false }
//   gm.state  -> latest view;  await gm.nextState()  -> waits for the next broadcast
//   srv.stop()
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function startServer({ port = 3100 + Math.floor(Math.random() * 800), quiet = true } = {}) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-test-'));
  const proc = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), SR_RUNTIME_DIR: runtime }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; if (!quiet) process.stdout.write(d); });
  proc.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
  const url = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(url + '/api/lobby'); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return { url, port, runtime, proc, output: () => out, stop: () => { proc.kill(); try { fs.rmSync(runtime, { recursive: true, force: true }); } catch {} } };
}

export async function login(url, body) {
  const r = await fetch(url + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j.token;
}

export function client(url, token) {
  return new Promise((resolve, reject) => {
    const socket = io(url, { auth: { token }, transports: ['websocket'] });
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
