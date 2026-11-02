// Local owner RPC client. Credentials stay in memory; never logged or persisted.
import { readFile } from 'node:fs/promises';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const base = new URL(process.env.DSH_RPC_URL || 'http://127.0.0.1:3258');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Only loopback Hosts are allowed');
export async function authenticate() {
  if (process.env.DSH_RPC_COOKIE) return process.env.DSH_RPC_COOKIE;
  if (process.env.DSH_RPC_TOKEN) {
    const url = new URL('/?token=' + encodeURIComponent(process.env.DSH_RPC_TOKEN), base);
    const response = await fetch(url, { redirect: 'manual' });
    if (response.status !== 303) throw new Error('Launch-token exchange failed');
    const cookie = response.headers.get('set-cookie');
    if (!cookie) throw new Error('Authentication did not return a cookie');
    return cookie.split(';')[0];
  }
  // Read only the machine-generated browser-session record. Refuse unfamiliar YAML.
  const text = await readFile(join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml'), 'utf8');
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(x => /^  ["']?client-connection\/browser-session["']?:\s*$/.test(x));
  if (start < 0) throw new Error('Browser-session authentication record unavailable');
  let end = start + 1;
  while (end < lines.length && (/^\s{4}/.test(lines[end]) || /^\s*$/.test(lines[end]))) end++;
  const record = lines.slice(start + 1, end).join('\n');
  if (!/^    kind: grant\s*$/m.test(record) || !/^      version: 1\s*$/m.test(record)) throw new Error('Unsupported browser-session record');
  const match = /^      secret: ["']?([A-Za-z0-9_-]{43})["']?\s*$/m.exec(record);
  if (!match) throw new Error('Unsupported browser-session signing material');
  const secret = Buffer.from(match[1], 'base64url');
  const issuedAt = Date.now();
  const body = Buffer.from(JSON.stringify({version: 1, authority: base.host, issuedAt, expiresAt: issuedAt + 300000})).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  secret.fill(0);
  const name = 'dsh-auth-' + createHash('sha256').update(base.host).digest('base64url');
  return `${name}=v1.${body}.${signature}`;
}
export async function call(method, args = {}, { mutate = false } = {}) {
  const readOnly = ['listBundles', 'listPlugins', 'listVersionExemptions', 'registries', 'inspect', 'waitForInstall'];
  if (!readOnly.includes(method) && !mutate) throw new Error('Mutation requires explicit --mutate');
  const endpoint = `pluginManager/${method}`;
  const rpcId = randomUUID();
  const response = await fetch(new URL(`/api/${endpoint}`, base), {
    method: 'POST', headers: {'content-type': 'application/json', cookie: await authenticate()},
    body: JSON.stringify({type: 'client-request', rpcId, method: endpoint, payload: {args}}),
    signal: AbortSignal.timeout(180000)
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const envelope = await response.json();
  if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId) throw new Error('RPC response mismatch');
  if (!envelope.result.ok) throw new Error(`RPC rejected: ${envelope.result.error.code}`);
  return envelope.result.value;
}
if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
const method = process.argv[2] || 'listBundles';
try {
  const raw = process.argv[3] || '{}';
  const args = JSON.parse(raw.startsWith('@') ? await readFile(raw.slice(1), 'utf8') : raw);
  console.log(JSON.stringify(await call(method, args, {mutate: process.argv.includes('--mutate')}), null, 2));
} catch (error) {
  // Fixed diagnostics exclude URLs, cookies, tokens, source text, and stack traces.
  const safe = /^(Mutation requires|RPC HTTP|RPC response mismatch|RPC rejected:|Browser-session authentication|Unsupported browser-session|Authentication did not|Launch-token exchange)/.test(error.message);
  console.error(safe ? error.message : 'Local RPC failed; authentication material was not printed.');
  process.exitCode = 1;
}
}
