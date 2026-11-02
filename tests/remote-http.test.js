import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { apply } from '../index.js';

const CONTROL = '/ssh-workspaces/v3/control';
const CATALOG = '/ssh-workspaces/v3/catalog';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-remote-http-'));
  const originalHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const routes = new Map(), removed = [], effects = [], events = new Map(), access = [], calls = { sessions: 0, presets: 0 };
  const ctx = {
    provide(name, value) { assert.equal(name, 'sshWorkspaceFiles'); this[name] = value; },
    effect(fn) {
      const cleanup = fn(); let live = true;
      const stop = async () => { if (live) { live = false; await cleanup?.(); } };
      effects.push(stop); return stop;
    },
    on(name, listener) {
      const set = events.get(name) ?? new Set(); events.set(name, set); set.add(listener);
      return () => set.delete(listener);
    },
    connection: {
      requestRejection(req) {
        access.push(['trust', req.url]);
        if (req.headers.host !== 'localhost' || (req.headers.origin && req.headers.origin !== 'http://localhost')) return 403;
        if (req.headers['x-reject-request'] === '401') return 401;
        return undefined;
      },
      admit(req) {
        access.push(['admit', req.url]);
        if (!req.headers.authorization) return { rejection: 401 };
        return { peer: { principal: { kind: req.headers.authorization === 'Bearer owner' ? 'owner' : 'guest' } } };
      },
    },
    webServer: { register(route) {
      assert.equal(route.kind, 'exact'); assert.ok(!routes.has(route.path)); routes.set(route.path, route);
      return () => { if (routes.get(route.path) === route) { routes.delete(route.path); removed.push(route.path); } };
    } },
    agents: { list: () => [], get: () => undefined }, sessions: { get: () => undefined },
    sessionController: { async inspect(id) {
      assert.equal(id, 'local-one'); return { meta: { sessionId: id, cwd: 'D:\\project' } };
    }, async list(input, signal) {
      calls.sessions++; assert.deepEqual(input, {}); assert.ok(signal instanceof AbortSignal);
      return { items: [{ sessionId: 'local-one', cwd: 'D:\\project', running: false, blank: true, privateExtra: 'omit' }] };
    } },
    agentPresets: { async list() { calls.presets++; return [{ id: 'standard', name: 'Standard', extra: 'omit' }]; } },
    workspaceRegistry: {}, sandboxPolicy: {}, attachments: {}, tools: {}, systemPrompt: {},
  };
  for (const name of ['llm', 'credentials', 'agentLoop', 'agentDefaultModel']) Object.defineProperty(ctx, name, { get() { throw new Error(`Forbidden service access: ${name}`); } });
  const dispose = async () => { for (const cleanup of [...effects].reverse()) await cleanup(); };
  const server = createServer((req, res) => {
    const route = routes.get(new URL(req.url, 'http://localhost').pathname);
    if (!route) { res.writeHead(404); res.end(); return; }
    Promise.resolve(route.handler(req, res)).catch(error => { res.writeHead(500); res.end(error.message); });
  });
  t.after(async () => {
    await dispose();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome;
    // Only the absolute, freshly allocated fixture directory is removed.
    assert.equal(resolve(home), home); assert.match(basename(home), /^dsh-remote-http-/);
    await rm(home, { recursive: true, force: true });
  });
  await apply(ctx);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  async function request(path, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const bytes = body === undefined ? undefined : Buffer.from(body);
      const req = httpRequest({ host: '127.0.0.1', port: server.address().port, path, method, agent: false,
        headers: { Host: 'localhost', Authorization: 'Bearer owner', ...(bytes ? { 'Content-Length': bytes.length } : {}), ...headers } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
        res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, headers: res.headers, text, json: text ? JSON.parse(text) : undefined }); });
      });
      req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('HTTP fixture request timed out')));
      req.end(bytes);
    });
  }
  const post = (value, options = {}) => request(CONTROL, { method: 'POST', body: JSON.stringify(value), ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  return { home, routes, removed, access, calls, request, post, dispose };
}

test('real HTTP routes enforce trust, authentication and owner before metadata', async t => {
  const f = await fixture(t);
  assert.deepEqual([...f.routes.keys()], [CONTROL, CATALOG]);
  for (const path of [CONTROL, CATALOG]) {
    let before = f.access.length;
    assert.equal((await f.request(path, { headers: { Host: 'evil.example' } })).status, 403);
    assert.deepEqual(f.access.slice(before).map(([stage]) => stage), ['trust']);
    before = f.access.length;
    assert.equal((await f.request(path, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.deepEqual(f.access.slice(before).map(([stage]) => stage), ['trust']);
    assert.equal((await f.request(path, { headers: { Authorization: '' } })).status, 401);
    assert.equal((await f.request(path, { headers: { 'X-Reject-Request': '401' } })).status, 401);
    assert.equal((await f.request(path, { headers: { Authorization: 'Bearer nonowner' } })).status, 403);
  }
  assert.deepEqual(f.calls, { sessions: 0, presets: 0 });
});

test('owner state and local catalog use no model or credential service', async t => {
  const f = await fixture(t);
  const state = await f.request(CONTROL);
  assert.equal(state.status, 200); assert.equal(state.headers['cache-control'], 'no-store');
  assert.deepEqual(state.json, { ok: true, value: { mode: 'local-harness-remote-execution', busy: false, targets: [], bindings: [] } });
  assert.deepEqual(f.calls, { sessions: 0, presets: 0 });
  const catalog = await f.request(CATALOG);
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.json, { ok: true, value: { sessions: [{ sessionId: 'local-one', cwd: 'D:\\project', running: false, blank: true }], presets: [{ id: 'standard', name: 'Standard' }] } });
  assert.deepEqual(f.calls, { sessions: 1, presets: 1 });
  const unbound = await f.request(`${CONTROL}?sessionId=local-one`);
  assert.deepEqual(unbound.json, { ok: true, value: { binding: null } });
});

test('owner saves only safe SSH fields and empty key/port preserve SSH config defaults', async t => {
  const f = await fixture(t);
  const profile = { id: 'build', label: 'Build', target: 'build-alias', remotePath: '/srv/project', sshPort: '', identityFile: '', apiKey: 'do-not-save', modelProxy: { apiKey: 'secret' }, arbitrary: 'omit' };
  const saved = await f.post({ action: 'save', input: profile });
  assert.equal(saved.status, 200); assert.equal(saved.json.ok, true);
  const expected = { id: 'build', label: 'Build', target: 'build-alias', remotePath: '/srv/project', python: 'python3' };
  const stored = JSON.parse(await readFile(join(f.home, 'ssh-workspaces', 'state.json'), 'utf8'));
  assert.deepEqual(stored, { version: 1, targets: [expected], bindings: [], workspaces: [] });
  assert.deepEqual(saved.json.value.targets[0], { ...expected, connection: { status: 'disconnected' }, workspace: null });
  const state = await f.request(CONTROL); assert.equal(state.json.value.targets.length, 1);
  assert.ok(!JSON.stringify(stored).includes('secret')); assert.deepEqual(f.calls, { sessions: 0, presets: 0 });
});

test('HTTP method, content type, malformed JSON and byte limit errors return stable statuses', async t => {
  const f = await fixture(t);
  let response = await f.request(CONTROL, { method: 'DELETE' });
  assert.equal(response.status, 405); assert.equal(response.headers.allow, 'GET, POST');
  response = await f.request(CATALOG, { method: 'POST' });
  assert.equal(response.status, 405); assert.equal(response.headers.allow, 'GET');
  response = await f.request(CONTROL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(response.status, 415);
  response = await f.request(CONTROL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' });
  assert.equal(response.status, 400); assert.equal(response.json.ok, false);
  response = await f.request(CONTROL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(32769) }) });
  assert.equal(response.status, 413); assert.equal(response.json.error, 'Request is too large');
  assert.deepEqual(f.calls, { sessions: 0, presets: 0 });
});

test('dispose unregisters exactly both routes and is idempotent', async t => {
  const f = await fixture(t);
  await f.dispose(); await f.dispose();
  assert.equal(f.routes.size, 0); assert.deepEqual([...f.removed].sort(), [CONTROL, CATALOG].sort());
  const response = await f.request(CONTROL);
  assert.equal(response.status, 404);
});
