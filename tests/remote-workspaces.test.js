import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { RemoteWorkspaceController } from '../remote-workspaces.js';

class ApiSessionNotFound extends Error {}
const target = (id = 'host') => ({ id, label: id, target: 'ssh-alias', remotePath: '/project', identityFile: '', sshPort: '' });
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'remote-workspaces-'));
  const sessions = new Map([['local', { header: { cwd: home }, model: 'local-model', memory: { local: true }, preset: 'local-preset' }]]);
  const rows = [{ sessionId: 'local', cwd: home, running: false, blank: false }];
  const calls = [], engines = [], workspaces = new Map();
  let controller;
  const services = {
    sessions,
    agentPresets: { list: async () => [{ id: 'local-preset', name: 'Local' }] },
    sessionController: {
      list: async () => ({ items: rows }),
      inspect: async id => {
        if (!sessions.has(id)) throw new ApiSessionNotFound(`session "${id}" not found`);
        return { meta: sessions.get(id).header, events: [] };
      },
      resolveAgent: async id => sessions.has(id) ? { agent: sessions.get(id) } : { error: new Error('not found') },
      create: async request => {
        calls.push(request);
        const cwd = workspaces.get(request.workspaceId);
        assert.ok(isAbsolute(cwd)); assert.notEqual(cwd, '/project');
        const disk = JSON.parse(await readFile(controller.file));
        assert.equal(disk.workspaces[0].anchorPath, cwd);
        const sessionId = `new-${calls.length}`;
        sessions.set(sessionId, { header: { cwd }, model: 'local-model', memory: { local: true } });
        assert.ok(await controller.bindingFor(sessionId), 'agent-created sees anchor binding');
        return { sessionId };
      },
    },
    workspaceRegistry: { create: async path => { assert.ok(isAbsolute(path)); workspaces.set('workspace', path); return { id: 'workspace', path }; } },
    executorFactory: () => {
      const engine = { disposed: 0, requests: [], root: '/canonical/project',
        probe: async () => ({ root: engine.root, hostname: 'remote', platform: 'linux' }),
        request: async (...args) => { engine.requests.push(args); if (engine.failure) throw engine.failure; return { ok: true }; },
        dispose: async () => { engine.disposed++; },
      }; engines.push(engine); return engine;
    },
  };
  controller = new RemoteWorkspaceController(home, services);
  t.after(async () => { await controller.dispose(); await rm(home, { recursive: true, force: true }); });
  return { home, controller, services, sessions, rows, calls, engines };
}
async function connected(f, id = 'host') { await f.controller.execute('save', target(id)); await f.controller.execute('connect', { id }); }
async function bind(f, sessionId = 'local', id = 'host') { await f.controller.execute('bind_session', { id, sessionId }); }
async function diskFailure(f, run) {
  const original = f.controller.file;
  const bad = join(f.home, 'directory-as-state'); await mkdir(bad, { recursive: true });
  const before = await readFile(original, 'utf8');
  f.controller.file = bad;
  try { await assert.rejects(run); } finally { f.controller.file = original; }
  assert.equal(await readFile(original, 'utf8'), before);
}

test('save omits SSH config overrides, uses safe IDs, and permits editing unrelated targets', async t => {
  const f = await fixture(t); await connected(f); await bind(f);
  assert.equal(Object.hasOwn(f.controller.target('host'), 'identityFile'), false);
  assert.equal(Object.hasOwn(f.controller.target('host'), 'sshPort'), false);
  for (const id of ['../escape', '_bad', 'a'.repeat(101)]) await assert.rejects(f.controller.execute('save', target(id)));
  await f.controller.execute('save', target('other'));
  await f.controller.execute('save', { ...target('other'), label: 'Changed' });
  await f.controller.execute('disconnect', { id: 'host' });
  await assert.rejects(f.controller.execute('save', { ...target(), label: 'Changed' }), /stable/);
  await assert.rejects(f.controller.execute('delete', { id: 'host' }), /used/);
});

test('all candidate writes roll back on real disk failure', async t => {
  const f = await fixture(t); await connected(f);
  await diskFailure(f, () => f.controller.execute('save', target('new')));
  assert.equal(f.controller.targets.has('new'), false);
  await diskFailure(f, () => bind(f)); assert.equal(await f.controller.bindingFor('local'), null);
  await bind(f);
  await diskFailure(f, () => f.controller.execute('unbind_session', { sessionId: 'local' }));
  assert.equal((await f.controller.bindingFor('local')).connected, true);
  await f.controller.execute('save', target('unused'));
  await diskFailure(f, () => f.controller.execute('delete', { id: 'unused' }));
  assert.ok(f.controller.targets.has('unused'));
  const previous = f.controller.bindings;
  await diskFailure(f, () => f.controller.execute('create_session', { id: 'host' }));
  assert.equal(f.controller.workspaces.size, 0); assert.equal(f.controller.bindings, previous); assert.equal(f.calls.length, 0);
  await f.controller.execute('create_session', { id: 'host' });
  const anchor = f.controller.workspaces.get('host');
  f.services.workspaceRegistry.create = async () => ({ id: 'replacement-workspace' });
  await diskFailure(f, () => f.controller.execute('create_session', { id: 'host' }));
  assert.equal(f.controller.workspaces.get('host'), anchor);
  assert.equal(anchor.workspaceId, 'workspace'); assert.equal(f.calls.length, 1);
});

test('bind validates typed inspection/resolution errors and idle state before committing', async t => {
  const f = await fixture(t); await connected(f);
  await assert.rejects(bind(f, 'missing'), /not found/); assert.equal(f.controller.bindings.size, 0);
  f.services.sessionController.resolveAgent = async () => ({ error: new Error('writer held') });
  await assert.rejects(bind(f), /writer held/); assert.equal(f.controller.bindings.size, 0);
  f.services.sessionController.resolveAgent = async () => ({ agent: f.sessions.get('local') });
  f.rows[0].running = true; await assert.rejects(bind(f), /idle/);
  f.rows[0].running = false; await bind(f);
  assert.equal(f.sessions.get('local').model, 'local-model');
  assert.deepEqual(f.sessions.get('local').memory, { local: true });
  assert.equal(f.sessions.get('local').preset, 'local-preset');
  assert.deepEqual((await f.controller.catalog()).sessions, f.rows);
});

test('binding precedence, parent inheritance, tombstones and bounded cycles', async t => {
  const f = await fixture(t); await connected(f); await bind(f);
  f.sessions.set('child', { header: { cwd: f.home, parentSession: 'local' } });
  assert.equal((await f.controller.bindingFor('child')).root, '/canonical/project');
  assert.equal(await f.controller.bindingFor('ordinary'), null);
  await f.controller.execute('unbind_session', { sessionId: 'child' });
  assert.equal(await f.controller.bindingFor('child'), null);
  f.sessions.set('cycle-a', { header: { parentSession: 'cycle-b' } }); f.sessions.set('cycle-b', { header: { parentSession: 'cycle-a' } });
  assert.equal(await f.controller.bindingFor('cycle-a'), null);
  for (let i = 0; i < 34; i++) f.sessions.set(`depth-${i}`, { header: { parentSession: i === 33 ? 'local' : `depth-${i + 1}` } });
  assert.equal(await f.controller.bindingFor('depth-0'), null);
});

test('native sessions use committed local anchors and preserve preset; cold reload never connects', async t => {
  const f = await fixture(t); await connected(f);
  const created = await f.controller.execute('create_session', { id: 'host', agentPreset: '' });
  assert.deepEqual(f.calls[0], { workspaceId: 'workspace', agentPreset: '' });
  assert.equal(f.controller.bindings.has(created.sessionId), false);
  const anchor = f.controller.workspaces.get('host');
  f.sessions.set('native', { header: { cwd: anchor.anchorPath } });
  assert.equal((await f.controller.bindingFor('native')).root, '/canonical/project');
  await f.controller.execute('create_session', { id: 'host' }); assert.equal(Object.hasOwn(f.calls[1], 'agentPreset'), false);
  const cold = new RemoteWorkspaceController(f.home, { ...f.services, executorFactory: () => { throw new Error('must not connect'); } });
  await cold.load(); assert.equal((await cold.bindingFor('native')).connected, false);
  await assert.rejects(cold.requestFor('native', 'read'), /disconnected/);
  await cold.execute('unbind_session', { sessionId: 'native' }); assert.equal(await cold.bindingFor('native'), null);
  await cold.dispose();
});

test('detached persisted anchor survives native workspace deletion without activating an agent', async t => {
  const f = await fixture(t); await connected(f);
  const created = await f.controller.execute('create_session', { id: 'host' });
  const meta = f.sessions.get(created.sessionId).header;
  f.sessions.delete(created.sessionId);
  f.services.workspaceRegistry.get = () => undefined;
  const inspections = [];
  f.services.sessionController.inspect = async id => {
    inspections.push(id);
    if (id !== created.sessionId) throw new ApiSessionNotFound('not found');
    return { meta, events: [] };
  };
  f.services.sessionController.resolveAgent = async () => { throw new Error('must not activate'); };
  const cold = new RemoteWorkspaceController(f.home, { ...f.services, executorFactory: () => { throw new Error('must not connect'); } });
  t.after(() => cold.dispose());
  await cold.load();
  const binding = await cold.bindingFor(created.sessionId);
  assert.equal(binding.profile.id, 'host');
  assert.equal(binding.root, '/canonical/project');
  assert.equal(binding.connected, false);
  await assert.rejects(cold.requestFor(created.sessionId, 'sidebar_tree'), /disconnected/);
  assert.deepEqual(inspections, [created.sessionId, created.sessionId]);
  assert.equal(f.calls.length, 1);
});

test('detached child follows persisted parent lineage and respects explicit tombstones', async t => {
  const f = await fixture(t); await connected(f);
  await f.controller.execute('create_session', { id: 'host' });
  const anchor = f.controller.workspaces.get('host');
  const headers = new Map([
    ['cold-child', { cwd: f.home, parentSession: 'cold-parent' }],
    ['cold-parent', { cwd: anchor.anchorPath }],
    ['cold-ordinary', { cwd: f.home }],
  ]);
  const inspections = [];
  f.services.sessionController.inspect = async id => {
    inspections.push(id);
    if (!headers.has(id)) throw new ApiSessionNotFound('not found');
    return { meta: headers.get(id), events: [] };
  };
  assert.equal((await f.controller.bindingFor('cold-child')).profile.id, 'host');
  assert.deepEqual(inspections, ['cold-child', 'cold-parent']);
  assert.equal(await f.controller.bindingFor('cold-ordinary'), null);
  await f.controller.execute('unbind_session', { sessionId: 'cold-child' });
  inspections.length = 0;
  assert.equal(await f.controller.bindingFor('cold-child'), null);
  assert.deepEqual(inspections, []);
});

test('unknown persisted sessions are misses but inspection failures never permit local fallback', async t => {
  const f = await fixture(t); await connected(f);
  assert.equal(await f.controller.bindingFor('missing'), null);
  for (const error of [
    Object.assign(new Error('storage read failed'), { code: 'EIO' }),
    Object.assign(new Error('cancelled'), { name: 'AbortError' }),
    new Error('session "broken" not found'),
  ]) {
    f.services.sessionController.inspect = async () => { throw error; };
    await assert.rejects(f.controller.bindingFor('broken'), thrown => thrown === error);
    await assert.rejects(f.controller.requestFor('broken', 'sidebar_tree'), thrown => thrown === error);
  }
  f.services.sessionController.inspect = async () => ({ events: [] });
  await assert.rejects(f.controller.bindingFor('broken'), /returned no header/);
  f.services.sessionController.inspect = undefined;
  await assert.rejects(f.controller.bindingFor('broken'), /inspection is unavailable/);
  // Explicit ownership needs no persisted lookup, even during a storage fault.
  f.controller.bindings.set('bound', { sessionId: 'bound', targetId: 'host', root: '/canonical/project' });
  assert.equal((await f.controller.bindingFor('bound')).profile.id, 'host');
  assert.equal(f.engines[0].requests.length, 0);
});

test('requests forward canonical cwd, explicit cwd, cancellation and timeout without replay', async t => {
  const f = await fixture(t); await connected(f); await bind(f);
  const signal = new AbortController().signal, engine = f.engines[0];
  await f.controller.requestFor('local', 'write', { path: 'a' }, { signal, timeoutMs: 123 });
  assert.deepEqual(engine.requests[0], ['write', { path: 'a', cwd: '/canonical/project' }, { signal, timeoutMs: 123 }]);
  await f.controller.requestFor('local', 'read', { cwd: '/canonical/project/sub' });
  assert.equal(engine.requests[1][1].cwd, '/canonical/project/sub');
  for (const code of ['STALE_VERSION', 'TIMEOUT']) {
    engine.failure = Object.assign(new Error(code), { code }); const count = engine.requests.length;
    await assert.rejects(f.controller.requestFor('local', 'write'), { code });
    assert.equal(engine.requests.length, count + 1); assert.equal(engine.disposed, 0);
  }
  let notified = false;
  f.controller.subscribeBindings(async () => { await Promise.resolve(); notified = true; });
  engine.failure = Object.assign(new Error('broken'), { code: 'PROTOCOL' });
  await assert.rejects(f.controller.requestFor('local', 'write'), { code: 'PROTOCOL' });
  assert.ok(notified); assert.equal(engine.disposed, 1); assert.equal((await f.controller.bindingFor('local')).connected, false);
});

test('explicit binding wins over anchor and root drift is rejected', async t => {
  const f = await fixture(t); await connected(f); await bind(f);
  await connected(f, 'other');
  await f.controller.execute('create_session', { id: 'other' });
  f.sessions.get('local').header.cwd = f.controller.workspaces.get('other').anchorPath;
  assert.equal((await f.controller.bindingFor('local')).profile.id, 'host');
  await f.controller.execute('disconnect', { id: 'host' });
  const factory = f.controller.executorFactory;
  f.controller.executorFactory = config => { const engine = factory(config); engine.root = '/changed'; return engine; };
  await assert.rejects(f.controller.execute('connect', { id: 'host' }), /canonical root changed/);
  assert.equal(f.controller.engines.has('host'), false);
  assert.equal((await f.controller.bindingFor('local')).root, '/canonical/project');
  await f.controller.execute('disconnect', { id: 'other' });
  await assert.rejects(f.controller.execute('save', { ...target('other'), remotePath: '/changed' }), /stable/);
  await assert.rejects(f.controller.execute('delete', { id: 'other' }), /used/);
});

test('snapshot derives native workspace sessions without persisting or overriding explicit records', async t => {
  const f = await fixture(t); await connected(f); await bind(f);
  await connected(f, 'other');
  await f.controller.execute('create_session', { id: 'other' });
  const anchor = f.controller.workspaces.get('other');
  f.sessions.set('native-anchor-session', { header: { cwd: anchor.anchorPath } });
  f.sessions.set('disabled-session', { header: { cwd: anchor.anchorPath } });
  await f.controller.execute('unbind_session', { sessionId: 'disabled-session' });
  f.services.workspaceRegistry.get = id => id === anchor.workspaceId
    ? { sessionIds: ['native-anchor-session', 'local', 'disabled-session', 'native-anchor-session'] }
    : undefined;
  const before = await readFile(f.controller.file, 'utf8');
  const bindings = f.controller.snapshot().bindings;
  assert.deepEqual(bindings.find(b => b.sessionId === 'native-anchor-session'), {
    sessionId: 'native-anchor-session', targetId: 'other', root: anchor.root, source: 'workspace',
  });
  assert.equal(bindings.filter(b => b.sessionId === 'native-anchor-session').length, 1);
  assert.equal(bindings.find(b => b.sessionId === 'local').targetId, 'host');
  assert.equal(bindings.some(b => b.sessionId === 'disabled-session'), false);
  assert.equal(f.controller.bindings.has('native-anchor-session'), false);
  assert.equal(await readFile(f.controller.file, 'utf8'), before);
});

test('notification awaits asynchronous subscribers and unsubscribe removes listener', async t => {
  const f = await fixture(t); await connected(f);
  let release, observed = false;
  const gate = new Promise(resolve => { release = resolve; });
  const stop = f.controller.subscribeBindings(async () => { await gate; observed = true; });
  let settled = false;
  const operation = bind(f).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  release(); await operation; assert.ok(observed);
  stop(); observed = false; await f.controller.notify(); assert.equal(observed, false);
});

test('SSH failure clears engine and dispose closes all engines without local service mutation', async t => {
  const f = await fixture(t); await connected(f); await bind(f);
  f.engines[0].failure = Object.assign(new Error('ssh'), { code: 'SSH_FAILED' });
  await assert.rejects(f.controller.requestFor('local', 'read'), { code: 'SSH_FAILED' });
  assert.equal(f.controller.engines.size, 0);
  await f.controller.execute('connect', { id: 'host' }); await connected(f, 'other');
  await f.controller.dispose(); assert.equal(f.controller.engines.size, 0);
  assert.ok(f.engines.every(e => e.disposed > 0)); assert.equal(f.sessions.get('local').model, 'local-model');
});

test('connect retries transient SSH probe failures with a fresh executor', async t => {
  const f = await fixture(t);
  await f.controller.execute('save', target());
  const factory = f.controller.executorFactory;
  let probes = 0;
  f.controller.executorFactory = config => {
    const engine = factory(config), probe = engine.probe;
    engine.probe = async () => {
      probes++;
      if (probes < 3) throw Object.assign(new Error('transient SSH failure'), { code: probes === 1 ? 'SSH_FAILED' : 'TIMEOUT' });
      return probe();
    };
    return engine;
  };
  await f.controller.execute('connect', { id: 'host' });
  assert.equal(probes, 3);
  assert.deepEqual(f.engines.map(engine => engine.disposed), [1, 1, 0]);
  assert.equal(f.controller.snapshot().targets[0].connection.status, 'ready');
});
