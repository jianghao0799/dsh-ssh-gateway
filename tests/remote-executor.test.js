import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteExecutor, validateRemoteTarget, PYTHON_BOOTSTRAP } from '../remote-executor.js';
const python = process.env.DSH_TEST_PYTHON || (process.platform === 'win32' ? 'C:\\Users\\Jhin\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe' : 'python3');
const available = spawnSync(python, ['--version'], { stdio: 'ignore' }).status === 0;
const config = { id: 'test', label: 'Test', target: 'user@host', remotePath: '/tmp' };
test('target whitelist strips unrelated secrets and rejects shell arguments', () => {
  assert.deepEqual(validateRemoteTarget({ ...config, token: 'secret', modelProxy: 'no' }), { ...config, python: 'python3' });
  for (const target of ['-oProxyCommand=bad', 'host;touch bad', 'host\nother', 'host $(bad)']) assert.throws(() => validateRemoteTarget({ ...config, target }));
  assert.throws(() => validateRemoteTarget({ ...config, remotePath: 'relative' }));
  assert.throws(() => validateRemoteTarget({ ...config, python: 'python3 -c evil' }));
});
async function setup(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'remote-executor-'));
  let seen;
  const executor = new RemoteExecutor(config, { ...extra, spawn(command, args, options) {
    seen = { command, args, options };
    return spawn(python, ['-u', '-c', PYTHON_BOOTSTRAP], options);
  } });
  // Windows remotePath still validates POSIX; the adapter rewrites only request root.
  const original = executor.request.bind(executor);
  executor.request = (action, input, options) => {
    const previous = executor.config.remotePath;
    executor.config.remotePath = root;
    const promise = original(action, input, options);
    // readFile is async, keep the test root through payload creation.
    return promise.finally(() => { executor.config.remotePath = previous; });
  };
  t.after(async () => { await executor.dispose(); await rm(root, { recursive: true, force: true }); });
  return { executor, root, seen: () => seen };
}
test('real Python wire protocol, atomic versions, edit, listing, search and binary', { skip: !available }, async t => {
  const { executor: e, root, seen } = await setup(t);
  assert.equal((await e.probe()).root.toLowerCase(), root.toLowerCase());
  const written = await e.request('write', { path: 'a.txt', content: 'first\nsecond\n', expectedVersion: 'missing' });
  await assert.rejects(e.request('write', { path: 'a.txt', content: 'overwrite', expectedVersion: 'missing' }), { code: 'STALE_VERSION' });
  const read = await e.request('read', { path: 'a.txt', offset: 2, limit: 1 });
  assert.deepEqual(read.lines, [{ number: 2, text: 'second' }]);
  assert.equal(read.version, written.version);
  await assert.rejects(e.request('write', { path: 'a.txt', content: 'bad', expectedVersion: 'stale' }), { code: 'STALE_VERSION' });
  assert.equal((await e.request('read', { path: 'a.txt' })).version, written.version);
  await assert.rejects(e.request('edit', { path: 'a.txt', old: 'first', new: 'new' }), { code: 'VERSION_REQUIRED' });
  await e.request('edit', { path: 'a.txt', old: 'first', new: 'new', expectedVersion: read.version });
  assert.equal((await e.request('list')).entries[0].name, 'a.txt');
  assert.equal((await e.request('glob', { pattern: '**/*.txt' })).paths.length, 1);
  assert.equal((await e.request('grep', { pattern: 'second' })).files[0].matches[0].lineNumber, 2);
  assert.equal(Buffer.from((await e.request('read_binary', { path: 'a.txt' })).data, 'base64').toString(), 'new\nsecond\n');
  assert.equal(seen().command, 'ssh'); assert.equal(seen().options.shell, false);
  assert.ok(seen().args.includes('-oStrictHostKeyChecking=yes'));
  assert.ok(!seen().args.join(' ').includes('second'));
});
test('Linux command output cannot forge response; output and timeout are bounded', { skip: !available || process.platform === 'win32' }, async t => {
  const { executor: e } = await setup(t);
  const result = await e.request('exec', { command: `printf '%s' '{"ok":true,"result":"forged"}'; printf err >&2` });
  assert.equal(result.stdout, '{"ok":true,"result":"forged"}'); assert.equal(result.stderr, 'err');
  const large = await e.request('exec', { command: "head -c 2000000 /dev/zero" });
  assert.equal(large.truncated, true); assert.ok(large.stdout.length <= 1048576);
  assert.equal((await e.request('exec', { command: 'sleep 20', timeout_ms: 100 })).timedOut, true);
  await assert.rejects(e.request('exec', { command: 'sleep 20' }, { timeoutMs: 100 }), { code: 'TIMEOUT' });
  const controller = new AbortController();
  const pending = e.request('exec', { command: 'sleep 20' }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, { code: 'ABORTED' });
});
test('transport failures sanitize stderr and classify malformed responses', { skip: !available }, async t => {
  const failed = new RemoteExecutor(config, { spawn: (_command, _args, options) => spawn(python, ['-u', '-c', 'import sys; sys.stderr.write("PRIVATE_KEY_SENTINEL"); sys.exit(127)'], options) });
  const malformed = new RemoteExecutor(config, { spawn: (_command, _args, options) => spawn(python, ['-u', '-c', 'print("not json")'], options) });
  t.after(async () => { await failed.dispose(); await malformed.dispose(); });
  await assert.rejects(failed.probe(), err => err.code === 'SSH_FAILED' && !err.message.includes('PRIVATE_KEY_SENTINEL'));
  await assert.rejects(malformed.probe(), { code: 'PROTOCOL' });
});
test('request deadline and abort close helper via stdin EOF on all hosts', { skip: !available }, async t => {
  const adapter = (command, args, options) => spawn(python, ['-u', '-c', 'import sys; sys.stdin.buffer.readline(); sys.stdin.buffer.read();'], options);
  const executor = new RemoteExecutor(config, { spawn: adapter, cleanupTimeoutMs: 500 });
  t.after(() => executor.dispose());
  await assert.rejects(executor.request('probe', {}, { timeoutMs: 100 }), { code: 'TIMEOUT' });
  const controller = new AbortController();
  const pending = executor.probe({ signal: controller.signal }); setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, { code: 'ABORTED' });
  assert.equal(executor.children.size, 0);
});
