import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function panelFixture(extra = []) {
  const host = { id: 'host', label: 'Cluster', target: 'cluster', remotePath: '/home/user', python: 'python3', connection: { status: 'ready', root: '/home/user' } };
  const state = { targets: [host, ...extra], bindings: [] };
  const values = [], operations = [], opened = [];
  let cursor = 0, module, Panel;
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity) }; },
    useState(initial) { const index = cursor++; if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial; return [values[index], value => { values[index] = value; }]; },
    useEffect() {},
    useSyncExternalStore(_subscribe, snapshot) { const value = snapshot(); return value && typeof value === 'object' && 'targets' in value ? state : value; }
  };
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(value) { module = value; } } }, location: { href: 'http://localhost/' }, URL,
    crypto: { randomUUID: () => 'new-workspace' },
    async fetch(_url, options) {
      const body = JSON.parse(options.body); operations.push(body);
      if (body.action === 'save') state.targets.push({ ...body.input, connection: { status: 'disconnected' } });
      if (body.action === 'connect') { const target = state.targets.find(t => t.id === body.input.id); target.connection = { status: 'ready', root: target.remotePath }; }
      return { ok: true, async json() { return { ok: true, value: { ...state, ...(body.action === 'create_session' ? { sessionId: 'session-created' } : {}) } }; } };
    }
  });
  module.factory(() => React).apply({ effect: fn => fn(), locale: { register: () => () => {}, bind: () => key => key, getSnapshot: () => 1 }, uiWorkspace: { openSession: id => opened.push(id) }, slots: { inject: (_name, fn) => fn(), register(options, view) { if (options.name === 'main') Panel = view; return () => {}; } } });
  function render() { cursor = 0; return Panel(); }
  function* walk(node) { if (!node || typeof node !== 'object') return; yield node; for (const child of node.children || []) yield* walk(child); }
  const nodes = tree => [...walk(tree)];
  const enter = path => { const tree = render(); nodes(tree).find(n => n.type === 'input' && n.props.placeholder === '/shared/group/project').props.onChange({ target: { value: path } }); return render(); };
  return { state, operations, opened, enter, nodes };
}

test('pasted shared directory creates a separate workspace without changing existing target', async () => {
  const f = await panelFixture();
  const path = "/shared/group storage/project O'Brien";
  const tree = f.enter(path);
  await f.nodes(tree).find(n => n.type === 'button' && n.children.includes('newSession')).props.onClick();
  assert.deepEqual(f.operations.map(op => op.action), ['save', 'connect', 'create_session']);
  assert.equal(f.operations[0].input.remotePath, path);
  assert.equal(f.operations[2].input.id, 'new-workspace');
  assert.equal(f.state.targets[0].remotePath, '/home/user');
  assert.deepEqual(f.opened, ['session-created']);
});

test('existing shared workspace is reused rather than duplicated', async () => {
  const f = await panelFixture([{ id: 'shared', label: 'Shared', target: 'cluster', python: 'python3', remotePath: '/groups/project', connection: { status: 'ready', root: '/groups/project' } }]);
  const tree = f.enter('/groups/project');
  await f.nodes(tree).find(n => n.type === 'button' && n.children.includes('newSession')).props.onClick();
  assert.deepEqual(f.operations.map(op => op.action), ['create_session']);
  assert.equal(f.operations[0].input.id, 'shared');
});

test('Enter browses the pasted absolute path; relative workspace paths are rejected', async () => {
  const f = await panelFixture();
  let tree = f.enter('/groups/project');
  const form = f.nodes(tree).find(n => n.type === 'form' && f.nodes(n).some(child => child.props.placeholder === '/shared/group/project'));
  form.props.onSubmit({ preventDefault() {} });
  await new Promise(setImmediate);
  assert.equal(f.operations[0].action, 'browse');
  assert.equal(f.operations[0].input.path, '/groups/project');
  f.operations.length = 0;
  tree = f.enter('relative/path');
  await f.nodes(tree).find(n => n.type === 'button' && n.children.includes('newSession')).props.onClick();
  assert.equal(f.operations.length, 0);
});

test('binding an existing session also uses the entered shared directory', async () => {
  const f = await panelFixture();
  let tree = f.enter('/groups/another-project');
  const label = f.nodes(tree).find(n => n.type === 'label' && n.children.includes('sessionId'));
  label.children.find(n => n.type === 'input').props.onChange({ target: { value: 'session-existing' } });
  tree = f.enter('/groups/another-project');
  await f.nodes(tree).find(n => n.type === 'button' && n.children.includes('bind')).props.onClick();
  assert.deepEqual(f.operations.map(op => op.action), ['save', 'connect', 'bind_session']);
  assert.equal(f.operations[2].input.id, 'new-workspace');
  assert.equal(f.operations[2].input.sessionId, 'session-existing');
  assert.equal(f.state.targets[0].remotePath, '/home/user');
});
