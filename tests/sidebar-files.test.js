import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { RemoteSidebarFiles } from '../sidebar-files.js';

function fixture(t, options) {
  const calls = [], listeners = new Set();
  const binding = { root: '/group/project', connected: true, profile: { id: 'target' } };
  const bytes = Buffer.from('<html><script>window.test=1</script></html>');
  const controller = {
    bindingFor: async id => id === 'remote' ? binding : null,
    subscribeBindings(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async requestFor(id, action, input, { signal }) {
      calls.push({ id, action, input, signal });
      if (!binding.connected) throw new Error('SSH disconnected');
      if (action === 'sidebar_tree') return { path: input.path, entries: [{ name: 'readme.txt', path: input.path + '/readme.txt', isDir: false, hidden: false, isSymlink: false, broken: false }], truncated: false };
      if (action === 'sidebar_stat') return { size: bytes.length, mtimeMs: 123, isDir: false, isFile: true };
      if (action === 'sidebar_read_binary_page') return { data: bytes.subarray(input.offset).toString('base64'), offset: input.offset, nextOffset: bytes.length, eof: true };
      if (action === 'sidebar_watch_snapshot') return { levels: input.paths.map(dir => ({ dir, fingerprint: 'first' })) };
      return { kind: 'text', content: 'remote content', size: 14 };
    },
  };
  const backend = new RemoteSidebarFiles(controller, options); t.after(() => backend.dispose());
  return { backend, binding, controller, calls, listeners, bytes };
}
test('remote cwd comes from binding and local sessions retain original handlers', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.backend.api('fs.read', { sessionId: 'local', path: '/tmp/file' }), { handled: false });
  assert.deepEqual(await f.backend.api('settings.get', { sessionId: 'remote' }), { handled: false });
  assert.equal(f.calls.length, 0);
  const remote = await f.backend.api('session.cwd', { sessionId: 'remote', cwd: 'C:\\local\\anchor' });
  assert.deepEqual(remote.value, { sessionId: 'remote', cwd: '/group/project', root: 'project', parent: '/group' });
  assert.equal((await f.backend.api('fs.read', { sessionId: 'remote', cwd: 'C:\\ignored', path: 'README.md' })).value.content, 'remote content');
  assert.equal(f.calls[0].input.path, '/group/project/README.md');
  assert.equal(f.calls[0].input.cwd, '/group/project');
});
test('chat addresses use the stored Windows base only to recover remote relative paths', async t => {
  const f = fixture(t);
  f.controller.sessions = { get: () => ({ header: { cwd: 'C:\\local\\anchor' } }) };
  for (const repoRoot of [undefined, '', 'C:\\local\\anchor']) {
    await f.backend.api('fs.read', { sessionId: 'remote', repoRoot, path: 'C:\\local\\anchor\\results\\图.txt' });
    assert.equal(f.calls.at(-1).input.path, '/group/project/results/图.txt');
  }
  await f.backend.api('fs.readPage', { sessionId: 'remote', path: '/shared/results/file.txt', offset: 24 });
  assert.equal(f.calls.at(-1).input.path, '/shared/results/file.txt');
  assert.equal(f.calls.at(-1).input.offset, 24);
  for (const path of ['C:\\other\\file', 'C:\\local\\anchor-other\\file', 'D:\\local\\anchor\\file']) {
    await assert.rejects(f.backend.api('fs.read', { sessionId: 'remote', path }), /POSIX/);
  }
  const cold = fixture(t);
  cold.controller.sessionController = { inspect: async () => ({ meta: { cwd: 'C:\\cold' } }) };
  const resolve = await cold.backend.addressResolver('remote', cold.binding.root);
  assert.equal(resolve('C:\\cold\\plot.png'), '/group/project/plot.png');
});

test('batch trees resolve POSIX paths and disconnected/unsupported requests never fall back', async t => {
  const f = fixture(t);
  const result = await f.backend.api('fs.trees', { sessionId: 'remote', paths: ['/group/project', 'src'], exclude: ['**/.git/**'] });
  assert.equal(result.handled, true); assert.deepEqual(result.value.levels.map(x => x.path), ['/group/project', '/group/project/src']);
  assert.deepEqual(f.calls[0].input.exclude, ['**/.git/**']);
  await assert.rejects(f.backend.api('fs.read', { sessionId: 'remote', path: 'C:\\anchor\\x' }), { code: 'remote-bad-request' });
  await assert.rejects(f.backend.api('fs.trees', { sessionId: 'remote', paths: Array(65).fill('/tmp') }), /1–64/);
  for (const method of ['fs.remove', 'git.stage', 'archive.build', 'changes.ops', 'open.external']) await assert.rejects(f.backend.api(method, { sessionId: 'remote' }), { code: 'remote-unsupported', status: 501 });
  await assert.rejects(f.backend.guard('remote'), { code: 'remote-unsupported' });
  f.binding.connected = false;
  const before = f.calls.length;
  await assert.rejects(f.backend.api('fs.read', { sessionId: 'remote', path: '/tmp/x' }), { code: 'remote-disconnected', status: 503 });
  assert.equal(f.calls.length, before);
  assert.equal((await f.backend.api('session.cwd', { sessionId: 'remote' })).value.cwd, '/group/project');
});
test('real HTTP raw and preview HTML are sandboxed and download bytes stay exact', async t => {
  const f = fixture(t);
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    f.backend.media('remote', '/group/project/example.html', res, { mediaType: 'text/html', html: url.searchParams.has('preview'), download: url.searchParams.has('download') }).catch(error => { res.writeHead(error.status || 500); res.end(error.message); });
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  for (const query of ['', '?preview', '?download']) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/${query}`);
    assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
    assert.match(response.headers.get('content-security-policy'), /^sandbox /);
    assert.ok(!response.headers.get('content-security-policy').includes('allow-same-origin'));
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    if (query === '?download') assert.match(response.headers.get('content-disposition'), /attachment/);
  }
  assert.ok(f.calls.filter(c => c.action === 'sidebar_read_binary_page').every(c => c.input.expectedSize === f.bytes.length && c.input.expectedMtimeMs === 123));
});
test('Windows chat image and PDF addresses stream through the SSH media backend', async t => {
  const f = fixture(t);
  f.controller.sessions = { get: () => ({ header: { cwd: 'C:\\local\\anchor' } }) };
  const server = createServer((req, res) => {
    const pdf = req.url === '/pdf';
    f.backend.media('remote', `C:\\local\\anchor\\${pdf ? 'report.pdf' : '图.png'}`, res, { mediaType: pdf ? 'application/pdf' : 'image/png' }).catch(error => { res.writeHead(500); res.end(error.message); });
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  for (const [route, type, path] of [['/image', 'image/png', '/group/project/图.png'], ['/pdf', 'application/pdf', '/group/project/report.pdf']]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), type);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
    assert.equal(f.calls.at(-1).input.path, path);
  }
});

test('remote media rejects non-regular files before requesting bytes', async t => {
  const f = fixture(t);
  f.controller.requestFor = async (_id, action) => {
    assert.equal(action, 'sidebar_stat'); return { size: 0, isDir: false, isFile: false };
  };
  await assert.rejects(f.backend.streamMedia('remote', '/group/project/pipe', {}), /not a regular file/);
});
class Socket extends EventEmitter {
  readyState = 1; messages = [];
  send(text) { this.messages.push(JSON.parse(text)); this.emit('sent'); }
  close() { if (this.readyState !== 1) return; this.readyState = 3; this.emit('close'); }
}
test('watch queues eager announcements and closes/cleans on binding change', async t => {
  const f = fixture(t), ws = new Socket();
  const started = f.backend.watch(ws, { url: '/sidebar/ws/fs-watch?sessionId=remote' });
  ws.emit('message', Buffer.from(JSON.stringify({ op: 'watch', path: '/group/project' })));
  const sent = once(ws, 'sent');
  assert.equal(await started, true); await sent;
  assert.deepEqual(ws.messages, [{ dir: '/group/project', ok: true }]);
  assert.equal(f.listeners.size, 1); assert.equal(f.backend.sockets.size, 1);
  for (const fn of [...f.listeners]) fn('remote');
  assert.equal(ws.readyState, 3); assert.equal(f.listeners.size, 0); assert.equal(f.backend.sockets.size, 0);
});
test('closing a socket during async binding lookup never starts a poll or leaks listeners', async t => {
  const f = fixture(t), ws = new Socket(); let finish;
  f.controller.bindingFor = () => new Promise(resolve => { finish = resolve; });
  const start = f.backend.watch(ws, { url: '/sidebar/ws/fs-watch?sessionId=remote' });
  ws.close(); finish(f.binding);
  assert.equal(await start, true); assert.equal(f.backend.sockets.size, 0); assert.equal(f.listeners.size, 0);
  assert.equal(ws.listenerCount('message'), 0);
});
