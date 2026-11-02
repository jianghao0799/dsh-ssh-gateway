import test from 'node:test';
import assert from 'node:assert/strict';
import { installRemoteTools } from '../remote-tools.js';

const binding = (connected = true) => ({ profile: { id: 'linux', label: 'Build host', target: 'user@linux', remotePath: '/root/project' }, root: '/root/project', connected });
const settle = () => new Promise(resolve => setImmediate(resolve));
function effects(target) {
  const active = new Set();
  target.effect = fn => {
    const cleanup = fn(); let live = true;
    const stop = () => { if (live) { live = false; active.delete(stop); cleanup?.(); } };
    active.add(stop); return stop;
  };
  target.dispose = () => { for (const stop of [...active]) stop(); };
  return target;
}
function harness() {
  const listeners = new Map(), live = new Map(), bindings = new Map(), calls = [], images = [], notices = [];
  const local = new Map(['read', 'pwsh', 'skill', 'remember'].map(name => [name, { name, local: true }]));
  let notify, policy = 'read-only', handler = async () => ({ content: 'ok', version: 'v1' });
  const ctx = effects({
    logger: { warn: (...args) => notices.push(args) },
    agents: { list: () => [...live.values()], get: id => live.get(id) },
    sessions: { get: id => live.has(id) ? { id, header: { cwd: 'D:\\anchor' } } : undefined },
    sandboxPolicy: { resolve: ({ session }) => { assert.ok(session); return { mode: policy }; } },
    attachments: { saveImage: async input => { images.push(input); return { attachmentId: 'img1', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1 }; } },
    on(name, listener) { const set = listeners.get(name) ?? new Set(); listeners.set(name, set); set.add(listener); return () => set.delete(listener); },
  });
  for (const key of ['llm', 'credentials', 'agentPresets']) Object.defineProperty(ctx, key, { get() { throw new Error(`${key} must stay untouched`); } });
  const controller = {
    bindingFor: async id => bindings.get(id) ?? null,
    requestFor: async (...args) => { calls.push(args); return handler(...args); },
    subscribeBindings(listener) { notify = listener; return () => { notify = undefined; }; },
  };
  async function emit(name, agent) { for (const listener of listeners.get(name) ?? []) await listener({ agent }); }
  async function agent(id, bound) {
    const definitions = new Map(), contexts = new Map();
    const scoped = effects({ tools: { register(def) { assert.ok(!definitions.has(def.name)); definitions.set(def.name, def); return () => definitions.delete(def.name); } }, systemPrompt: { context(def) { assert.ok(!contexts.has(def.name)); contexts.set(def.name, def); return () => contexts.delete(def.name); } } });
    const result = { id, ctx: scoped, definitions, contexts, get: name => definitions.get(name) ?? local.get(name) };
    live.set(id, result); if (bound) bindings.set(id, binding());
    await emit('agent/created', result); return result;
  }
  const dispose = installRemoteTools(ctx, controller);
  return { ctx, controller, bindings, calls, images, notices, local, agent, dispose, emit,
    set policy(value) { policy = value; }, set handler(value) { handler = value; },
    async change(id, value) { if (value) bindings.set(id, value); else bindings.delete(id); await notify?.(id); },
    async reload() { await notify?.(null); },
    run(agent, name, args, signal = new AbortController().signal) { return agent.definitions.get(name).execute(args, { agent, signal }); },
  };
}

test('model-facing parameters are object JSON Schemas, not unconverted defineTool DSL', async () => {
  const h = harness(), agent = await h.agent('schema', true);
  for (const definition of agent.definitions.values()) {
    const schema = definition.parameters;
    assert.equal(schema.type, 'object', definition.name);
    assert.equal(schema.additionalProperties, false);
    assert.equal(typeof schema.properties, 'object');
    assert.ok(Array.isArray(schema.required));
    assert.deepEqual(Object.keys(schema).sort(), ['additionalProperties', 'properties', 'required', 'type']);
    for (const name of schema.required) assert.ok(Object.hasOwn(schema.properties, name));
    for (const property of Object.values(schema.properties)) {
      assert.equal(typeof property.type, 'string');
      assert.equal(Object.hasOwn(property, 'required'), false, 'required belongs to the object schema as an array');
      assert.equal(typeof property.description, 'string');
    }
  }
  assert.deepEqual(agent.get('remote_exec').parameters.required, ['command']);
  assert.deepEqual(agent.get('remote_files').parameters.required, ['action']);
  assert.equal(agent.get('remote_files').parameters.properties.pattern.type, 'string');
  assert.equal(Object.hasOwn(agent.get('remote_files').parameters, 'pattern'), false);
  h.dispose();
});

test('only bound agents receive remote tools; original local tools and models remain untouched', async () => {
  const h = harness(), bound = await h.agent('bound', true), other = await h.agent('local');
  assert.deepEqual([...bound.definitions.keys()], ['remote_exec', 'remote_files']);
  assert.equal(other.definitions.size, 0); assert.equal(other.contexts.size, 0);
  for (const [name, definition] of h.local) assert.equal(bound.get(name), definition);
  const notice = [...bound.contexts.values()][0];
  assert.equal(notice.required, true);
  assert.match(notice.text(), /models, credentials, skills, memory, and plugins/);
  assert.match(notice.text(), /Existing local tools stay local/);
  assert.match(notice.text(), /read its text locally/);
  h.dispose();
});

test('reads work under confinement while exec and mutations fail closed for every non-full mode', async () => {
  const h = harness(), a = await h.agent('a', true);
  for (const mode of ['read-only', 'workspace-write', 'unknown']) {
    h.policy = mode;
    await h.run(a, 'remote_files', { action: 'read', path: 'x' });
    await assert.rejects(h.run(a, 'remote_exec', { command: 'pwd' }), { code: 'REMOTE_FULL_ACCESS_REQUIRED' });
    await assert.rejects(h.run(a, 'remote_files', { action: 'write', path: 'x', content: '', expected_version: 'v1' }), /Select Full access in the DSH UI/);
  }
  assert.equal(h.calls.length, 3);
  h.policy = 'danger-full-access';
  await h.run(a, 'remote_exec', { command: 'pwd' });
  assert.deepEqual(h.calls.at(-1).slice(0, 3), ['a', 'exec', { command: 'pwd', timeout_ms: 60000 }]);
  assert.equal(h.calls.at(-1)[3].timeoutMs, 75000);
  await h.run(a, 'remote_exec', { command: 'pwd', timeout_ms: 600000 });
  assert.equal(h.calls.at(-1)[2].timeout_ms, 600000);
  assert.equal(h.calls.at(-1)[3].timeoutMs, 615000);
  h.dispose();
});

test('version guards are required and stale versions reach the authoritative helper unchanged', async () => {
  const h = harness(), a = await h.agent('a', true); h.policy = 'danger-full-access';
  await assert.rejects(h.run(a, 'remote_files', { action: 'write', path: 'x', content: 'x' }), /expected_version/);
  h.handler = async () => { throw Object.assign(new Error('stale version'), { code: 'VERSION_CONFLICT' }); };
  await assert.rejects(h.run(a, 'remote_files', { action: 'edit', path: 'x', old_string: 'a', new_string: 'b', expected_version: 'old' }), { code: 'VERSION_CONFLICT' });
  assert.deepEqual(h.calls.at(-1)[2], { path: 'x', expectedVersion: 'old', old: 'a', new: 'b' });
  h.handler = async () => ({ version: 'new' });
  await h.run(a, 'remote_files', { action: 'write', path: 'new', content: '', expected_version: 'missing' });
  assert.deepEqual(h.calls.at(-1)[2], { path: 'new', content: '', expectedVersion: 'missing' });
  await h.run(a, 'remote_files', { action: 'edit', path: 'x', old_string: 'a', new_string: '', replace_all: true, expected_version: 'new' });
  assert.deepEqual(h.calls.at(-1)[2], { path: 'x', expectedVersion: 'new', old: 'a', new: '', replaceAll: true }); h.dispose();
});

test('runtime input validation rejects malformed, unknown and local path requests', async () => {
  const h = harness(), a = await h.agent('a', true); h.policy = 'danger-full-access';
  for (const args of [null, { action: 'delete' }, { action: 'read', path: 'C:\\secret' }, { action: 'read', path: 'x', content: 'hidden write' }, { action: 'grep', pattern: '' }, { action: 'read', path: 'x', limit: 0 }, { action: 'edit', path: 'x', old_string: 'a', new_string: '', expected_version: 'missing' }]) await assert.rejects(h.run(a, 'remote_files', args), { code: 'INVALID_REQUEST' });
  for (const args of [{ command: '' }, { command: 'x', timeout_ms: 600001 }, { command: 'x', cwd: 'file:///local' }, { command: 'x', extra: true }]) await assert.rejects(h.run(a, 'remote_exec', args), { code: 'INVALID_REQUEST' });
  assert.equal(h.calls.length, 0); h.dispose();
});

test('read_image commits bytes locally and removes encoded data from the model value', async () => {
  const h = harness(), a = await h.agent('a', true);
  h.handler = async () => ({ path: '/root/project/p.png', data: 'aGVsbG8=', mediaType: 'image/png', version: 'v2', hidden: 'omit' });
  const result = await h.run(a, 'remote_files', { action: 'read_image', path: 'p.png' });
  assert.equal(h.calls[0][1], 'read_binary');
  assert.equal(h.images[0].data.toString(), 'hello');
  assert.equal(result.attachment.attachmentId, 'img1');
  assert.equal(result.version, 'v2'); assert.equal(Object.hasOwn(result, 'data'), false); assert.equal(Object.hasOwn(result, 'hidden'), false);
  h.handler = async () => ({ data: 'garbage!', mediaType: 'image/png' });
  await assert.rejects(h.run(a, 'remote_files', { action: 'read_image', path: 'p.png' }), { code: 'INVALID_IMAGE' }); h.dispose();
});

test('disconnect retains schema, reconnect updates closure, unbind removes resources', async () => {
  const h = harness(), a = await h.agent('a', true), original = a.definitions.get('remote_files');
  await h.change('a', binding(false));
  assert.equal(a.definitions.get('remote_files'), original);
  assert.match([...a.contexts.values()][0].text(), /disconnected/);
  await assert.rejects(h.run(a, 'remote_files', { action: 'read', path: 'x' }), { code: 'REMOTE_DISCONNECTED' });
  const changed = binding(); changed.root = '/new'; await h.change('a', changed);
  assert.equal(a.definitions.get('remote_files'), original); assert.match([...a.contexts.values()][0].text(), /\/new/);
  await h.change('a', null); assert.equal(a.definitions.size, 0); assert.equal(a.contexts.size, 0);
  await assert.rejects(original.execute({ action: 'read', path: 'x' }, { agent: a }), { code: 'REMOTE_UNBOUND' });
  await h.change('a', binding()); assert.equal(a.definitions.size, 2); h.dispose();
});

test('agent disposal and plugin unload independently clear owned resources and reject retained callbacks', async () => {
  const h = harness(), a = await h.agent('a', true), b = await h.agent('b', true);
  const retained = a.definitions.get('remote_files');
  a.ctx.dispose(); await h.emit('agent/disposed', a);
  assert.equal(a.definitions.size, 0); assert.equal(a.contexts.size, 0);
  await h.reload(); assert.equal(a.definitions.size, 0);
  await assert.rejects(retained.execute({ action: 'read', path: 'x' }, { agent: a }), { code: 'REMOTE_UNBOUND' });
  h.dispose(); h.dispose(); assert.equal(b.definitions.size, 0); b.ctx.dispose();
  const j = harness(), c = await j.agent('c', true); j.ctx.dispose(); assert.equal(c.definitions.size, 0); c.ctx.dispose();
});

test('read-only action scheduling permits concurrency; commands, changes and unknown actions remain exclusive', async () => {
  const h = harness(), a = await h.agent('a', true), files = a.definitions.get('remote_files');
  for (const action of ['read', 'list', 'glob', 'grep', 'read_image']) assert.equal(files.isConcurrencySafe({ action }), true);
  for (const action of ['write', 'edit', 'delete', undefined]) assert.equal(files.isConcurrencySafe({ action }), false);
  assert.equal(files.isConcurrencySafe(null), false); assert.equal(a.definitions.get('remote_exec').isConcurrencySafe({ command: 'ls' }), false);
  let entered = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  h.handler = async () => { entered++; await gate; return {}; };
  const calls = [h.run(a, 'remote_files', { action: 'read', path: 'a' }), h.run(a, 'remote_files', { action: 'read', path: 'b' })];
  await settle(); assert.equal(entered, 2); release(); await Promise.all(calls); h.dispose();
});

test('aborted calls and cross-agent retained callbacks cannot reach transport', async () => {
  const h = harness(), a = await h.agent('a', true), b = await h.agent('b');
  const abort = new AbortController(); abort.abort();
  await assert.rejects(h.run(a, 'remote_files', { action: 'read', path: 'x' }, abort.signal));
  await assert.rejects(a.definitions.get('remote_files').execute({ action: 'read', path: 'x' }, { agent: b }), { code: 'REMOTE_UNBOUND' });
  assert.equal(h.calls.length, 0); h.dispose();
});

test('binding notification resolves only after asynchronous registration is ready', async () => {
  const h = harness(), a = await h.agent('a');
  const original = h.controller.bindingFor;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  h.controller.bindingFor = async id => { await gate; return original(id); };
  let returned = false;
  const change = h.change('a', binding()).then(() => { returned = true; });
  await settle(); assert.equal(returned, false); assert.equal(a.definitions.size, 0);
  release(); await change;
  assert.equal(returned, true); assert.equal(a.definitions.size, 2);
  await h.run(a, 'remote_files', { action: 'read', path: 'first-prompt.txt' });
  assert.equal(h.calls.length, 1); h.dispose();
});

test('parent binding changes refresh already live children inheriting that binding', async () => {
  const h = harness(), parent = await h.agent('parent'), child = await h.agent('child');
  const direct = h.controller.bindingFor;
  h.controller.bindingFor = async id => await direct(id) ?? (id === 'child' ? direct('parent') : null);
  await h.change('parent', binding());
  assert.equal(parent.definitions.size, 2); assert.equal(child.definitions.size, 2);
  const definition = child.definitions.get('remote_files');
  await h.change('parent', binding(false));
  assert.equal(child.definitions.get('remote_files'), definition);
  assert.match([...child.contexts.values()][0].text(), /disconnected/);
  await assert.rejects(h.run(child, 'remote_files', { action: 'read', path: 'x' }), { code: 'REMOTE_DISCONNECTED' });
  await h.change('parent', null);
  assert.equal(parent.definitions.size, 0); assert.equal(child.definitions.size, 0);
  assert.equal(child.contexts.size, 0); h.dispose();
});

test('additional schema/context footprint stays bounded (heuristic chars/4, not measured LLM tokens)', async t => {
  const h = harness(), a = await h.agent('a', true);
  const visible = [...a.definitions.values()].map(({ name, description, parameters }) => ({ name, description, parameters }));
  const chars = JSON.stringify(visible).length + [...a.contexts.values()][0].text().length;
  const estimatedTokens = Math.ceil(chars / 4);
  t.diagnostic(`Before: 0 added tokens; after: ~${estimatedTokens} added tokens by chars/4 heuristic (${chars} chars), no LLM invoked.`);
  assert.ok(estimatedTokens < 1300); h.dispose();
});
