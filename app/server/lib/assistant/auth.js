// GM assistant — authentication to the Claude API.
//
// Preferred: Workload Identity Federation. This server acts as its own tiny OIDC issuer: an EC P-256 key pair
// lives in runtime/assistant/signing-key.pem (never leaves the server), its public JWK is registered once in the
// Claude Console (Custom OIDC, inline JWKS), and every token exchange signs a fresh short-lived JWT (unique jti).
// The SDK exchanges it for a short-lived, workspace-scoped Anthropic token and caches it until expiry.
// Env: ANTHROPIC_FEDERATION_RULE_ID, ANTHROPIC_ORGANIZATION_ID, optional ANTHROPIC_WORKSPACE_ID / ANTHROPIC_SERVICE_ACCOUNT_ID.
//
// Fallback (local development only): ANTHROPIC_API_KEY.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { oidcFederationProvider } from '@anthropic-ai/sdk/lib/credentials/oidc-federation';
import { ASSISTANT_DIR } from './config.js';

const KEY_FILE = () => path.join(ASSISTANT_DIR, 'signing-key.pem');
export const ISSUER = process.env.SR_ASSISTANT_ISSUER || 'https://shadowrun-table.internal';
export const SUBJECT = process.env.SR_ASSISTANT_SUBJECT || `shadowrun-table:${(process.env.SR_ASSISTANT_HOST || os.hostname() || 'server').toLowerCase().replace(/[^a-z0-9.-]/g, '-').slice(0, 60)}`;
export const SUBJECT_PREFIX = 'shadowrun-table:';
const JWT_LIFETIME_S = 600;
const API_BASE = 'https://api.anthropic.com';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const env = (k) => (process.env[k] || '').trim();

let keyCache = null; // { privateKey, jwk, kid }

/** Load the signing key, creating it (0600) on first use. */
export function signingKey() {
  if (keyCache) return keyCache;
  const file = KEY_FILE();
  let pem;
  try {
    pem = fs.readFileSync(file, 'utf8');
  } catch {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, pem, { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {}
    console.log('[assistant] nouvelle clé de signature créée :', file);
  }
  const privateKey = crypto.createPrivateKey(pem);
  const pub = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  // RFC 7638 thumbprint as key id (stable for this key, changes when the key is rotated).
  const kid = b64url(crypto.createHash('sha256').update(JSON.stringify({ crv: pub.crv, kty: pub.kty, x: pub.x, y: pub.y })).digest()).slice(0, 22);
  const jwk = { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y, kid, alg: 'ES256', use: 'sig' };
  keyCache = { privateKey, jwk, kid };
  return keyCache;
}

/** The public half, as pasted into the Console (inline JWKS). */
export function publicJwks() {
  return { keys: [signingKey().jwk] };
}

/** A fresh signed identity token (ES256, unique jti, 10 minutes). */
export function mintIdentityToken(now = Date.now()) {
  const { privateKey, kid } = signingKey();
  const iat = Math.floor(now / 1000);
  const header = { alg: 'ES256', typ: 'JWT', kid };
  // The token endpoint rejects assertions without `aud` (reason jwt_required_claim_missing), even though rules need not match on it.
  const payload = { iss: ISSUER, sub: SUBJECT, aud: env('SR_ASSISTANT_AUDIENCE') || API_BASE, iat, nbf: iat - 5, exp: iat + JWT_LIFETIME_S, jti: crypto.randomUUID() };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64url(sig)}`;
}

/** 'wif' | 'apikey' | null */
export function authMode() {
  if (env('ANTHROPIC_FEDERATION_RULE_ID') && env('ANTHROPIC_ORGANIZATION_ID')) return 'wif';
  if (env('ANTHROPIC_API_KEY')) return 'apikey';
  return null;
}

const status = { lastOk: null, lastError: null, lastErrorAt: null };
export function authStatus() {
  return {
    mode: authMode(),
    issuer: ISSUER,
    subject: SUBJECT,
    subjectPrefix: SUBJECT_PREFIX,
    ruleConfigured: !!env('ANTHROPIC_FEDERATION_RULE_ID'),
    orgConfigured: !!env('ANTHROPIC_ORGANIZATION_ID'),
    workspaceConfigured: !!env('ANTHROPIC_WORKSPACE_ID'),
    ...status,
  };
}

let factory = null;
let client = null;
/** Test hook: replace the client (e.g. a fake that never calls the network). null restores the real one. */
export function setClientFactory(fn) {
  factory = fn;
  client = null;
}

/** The shared Anthropic client, or null when no credentials are configured. */
export function getClient() {
  if (client) return client;
  if (factory) return (client = factory());
  const mode = authMode();
  if (mode === 'wif') {
    const exchange = oidcFederationProvider({
      identityTokenProvider: () => mintIdentityToken(),
      federationRuleId: env('ANTHROPIC_FEDERATION_RULE_ID'),
      organizationId: env('ANTHROPIC_ORGANIZATION_ID'),
      serviceAccountId: env('ANTHROPIC_SERVICE_ACCOUNT_ID') || undefined,
      workspaceId: env('ANTHROPIC_WORKSPACE_ID') || undefined,
      baseURL: API_BASE,
      fetch: globalThis.fetch.bind(globalThis),
    });
    const credentials = async (opts) => {
      try {
        const res = await exchange(opts);
        status.lastOk = Date.now();
        status.lastError = null;
        return res;
      } catch (err) {
        status.lastError = String(err?.message || err).slice(0, 500);
        status.lastErrorAt = Date.now();
        throw err;
      }
    };
    client = new Anthropic({ credentials, maxRetries: 2, timeout: 5 * 60 * 1000 });
  } else if (mode === 'apikey') {
    client = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY'), maxRetries: 2, timeout: 5 * 60 * 1000 });
  }
  return client;
}

/** Record a successful call for API-key mode too (the status line in /admin). */
export function markCallOk() {
  status.lastOk = Date.now();
}

/** Test hook. */
export function _resetAuthCache() {
  keyCache = null;
  client = null;
}
