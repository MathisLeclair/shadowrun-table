// Test helper: start an isolated server and drive it over Socket.IO like a real client.
//   import { startServer, login, client } from './test-client.ts';
//   const srv = await startServer({ port: 3101 });           // fresh runtime in a temp dir: one table "lazarus" (seeds applied)
//   const gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' }));
//   const result = await gm.send('maps/moveToken', { ... });  // throws on { ok:false }
//   gm.state  -> latest view;  await gm.nextState()  -> waits for the next broadcast
//   srv.stop()
// Multi-table:
//   const srv = await startServer({ port, tables: [{ id: 'alpha', pack: 'blank', gmPassword: 'secret-a' }, { id: 'beta' }] });
//     → those tables exist at boot (no bootstrap "lazarus" table unless `bootstrap: true`)
//   login(srv.url, { role: 'gm', password, table: 'alpha' }) ; client(srv.url, token, { table: 'alpha' })
//   const adminToken = await srv.admin();  // admin password: srv.adminPassword
//   startServer({ legacyState: {...} })     → writes <runtime>/state.json (old single-table layout) before boot
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type { Actor, ActorId, ActionPayload, ActionResponse, GameView, Lang, PackId, ServerEvents } from '../shared/types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A table created on disk before boot (`startServer({ tables })`). */
export interface TestTableSpec {
  id: string;
  name?: string;
  pack?: PackId;
  lang?: Lang;
  gmPassword?: string;
  legacy?: boolean;
  hidden?: boolean;
  /** Raw state.json content (fixtures are often partial or old-format, hence `object`). Default: an empty table. */
  state?: object;
}

export interface StartServerOptions {
  port?: number;
  /** false: echo the server's stdout. */
  quiet?: boolean;
  env?: Record<string, string>;
  /** Tables written before boot; when given, no bootstrap "lazarus" table unless `bootstrap: true`. */
  tables?: TestTableSpec[] | null;
  bootstrap?: boolean;
  /** Old single-table layout: written as <runtime>/state.json before boot. */
  legacyState?: object | null;
  adminPassword?: string;
  /** Reuse an existing runtime dir (restart tests). */
  runtime?: string | null;
  /** Never delete the runtime dir on stop. */
  keepRuntime?: boolean;
}

export interface TestServer {
  url: string;
  port: number;
  runtime: string;
  proc: ChildProcess;
  adminPassword: string;
  /** Everything the server printed so far (stdout + stderr). */
  output(): string;
  /** Log in as server admin, returns the admin bearer token. */
  admin(password?: string): Promise<string>;
  /** Stop the process (waits for its exit); `keep` keeps the runtime dir (restart tests). */
  stopAndWait(opts?: { keep?: boolean }): Promise<void>;
  /** Kill the process without waiting, then delete the runtime dir (unless keepRuntime). */
  stop(): void;
}

/** Body of POST /api/login. */
export interface LoginBody {
  role: 'gm' | 'player';
  password?: string;
  userId?: string;
  name?: string;
  table?: string;
  [key: string]: unknown;
}

/**
 * A view as tests read it. Actors are typed as full sheets: that is what the GM view holds and what a player gets for
 * PCs. NPCs a player does not control arrive as stubs (`NpcStub`), so tests reading those use only the stub fields.
 */
export type TestView = Omit<GameView, 'actors'> & { actors: Record<ActorId, Actor> };

/** A transient socket event as recorded in `client.events`. */
export type TestEvent = { [E in keyof ServerEvents]: { ev: E; data: ServerEvents[E] } }[keyof ServerEvents];

export interface TestClient {
  socket: Socket;
  /** Latest view (set before client() resolves). */
  state: TestView;
  /** Every non-'state' event received, in order (tests clear it with `events.length = 0`). */
  events: TestEvent[];
  /**
   * Run an action; resolves with its result, rejects with the server's error text on { ok:false }. The result shape
   * depends on the action (there is no typed action registry), so it defaults to `any`: pass `T` to pin it down.
   */
  send<T = any>(type: string, payload?: ActionPayload): Promise<T>;
  /** Waits for the next 'state' broadcast. */
  nextState(): Promise<TestView>;
  close(): void;
}

function writeTable(runtime: string, t: TestTableSpec): void {
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
}: StartServerOptions = {}): Promise<TestServer> {
  const runtime = givenRuntime || fs.mkdtempSync(path.join(os.tmpdir(), 'sr-test-'));
  if (legacyState) fs.writeFileSync(path.join(runtime, 'state.json'), JSON.stringify(legacyState));
  for (const t of tables || []) writeTable(runtime, t);
  const childEnv: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), SR_RUNTIME_DIR: runtime, SR_ADMIN_PASSWORD: adminPassword, ...env };
  if (tables && !bootstrap) childEnv.SR_BOOTSTRAP_TABLE = 'none';
  // Node runs the TypeScript server directly; before 22.18 type stripping needs a flag (no-op when NODE_OPTIONS already has it).
  const stripTypes = process.execArgv.filter((a) => a === '--experimental-strip-types' || a === '--no-warnings');
  const proc = spawn(process.execPath, [...stripTypes, 'server/index.ts'], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d: Buffer) => { out += d; if (!quiet) process.stdout.write(d); });
  proc.stderr.on('data', (d: Buffer) => { out += d; process.stderr.write(d); });
  const url = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(url + '/api/health'); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const exited = new Promise<void>((r) => proc.once('exit', () => r()));
  return {
    url, port, runtime, proc, adminPassword, output: () => out,
    async admin(password = adminPassword) {
      const r = await fetch(url + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
      const j = (await r.json()) as { token?: string; error?: string };
      if (!r.ok || !j.token) throw new Error(j.error);
      return j.token;
    },
    async stopAndWait({ keep = false } = {}) {
      proc.kill();
      await exited;
      if (!keep && !keepRuntime) try { fs.rmSync(runtime, { recursive: true, force: true }); } catch {}
    },
    stop: () => { proc.kill(); if (!keepRuntime) try { fs.rmSync(runtime, { recursive: true, force: true }); } catch {} },
  };
}

/** POST /api/login; returns the session token (throws the server's error text). */
export async function login(url: string, body: LoginBody): Promise<string> {
  const r = await fetch(url + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await r.json()) as { token?: string; error?: string };
  if (!r.ok || !j.token) throw new Error(j.error);
  return j.token;
}

/** Connect a Socket.IO client; resolves once the first view has arrived. */
export function client(url: string, token: string, { table }: { table?: string } = {}): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = io(url, { auth: table ? { token, table } : { token }, transports: ['websocket'] });
    const waiters: Array<(s: TestView) => void> = [];
    const c: TestClient = {
      // Filled by the first 'state' event, which happens before the promise resolves.
      socket, state: null as unknown as TestView, events: [],
      send<T>(type: string, payload: ActionPayload = {}) {
        return new Promise<T>((res, rej) => socket.emit('action', { type, payload }, (r?: ActionResponse) => {
          if (r && r.ok) res(r.result as T);
          else rej(new Error(r ? r.error : 'no reply'));
        }));
      },
      nextState() { return new Promise<TestView>((res) => waiters.push(res)); },
      close() { socket.close(); },
    };
    socket.onAny((ev: string, data: unknown) => { if (ev !== 'state') c.events.push({ ev, data } as TestEvent); });
    socket.on('state', (s: TestView) => { c.state = s; while (waiters.length) waiters.shift()!(s); });
    socket.once('state', () => resolve(c));
    socket.on('connect_error', reject);
  });
}

/** Wait for broadcasts to settle (debounced 30ms server-side). */
export const settle = (ms = 350): Promise<void> => new Promise((r) => setTimeout(r, ms));
