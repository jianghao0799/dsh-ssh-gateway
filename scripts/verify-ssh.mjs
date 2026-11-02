import assert from 'node:assert/strict';
import { RemoteExecutor } from '../remote-executor.js';

const target = process.env.SSH_TARGET;
if (!target) throw new Error('Set SSH_TARGET to an SSH config alias or user@host');
const sshPort = process.env.SSH_PORT ? Number(process.env.SSH_PORT) : undefined;
const identityFile = process.env.SSH_IDENTITY_FILE || undefined;
const python = process.env.SSH_PYTHON || 'python3';
const executor = new RemoteExecutor({
  id: 'acceptance-test',
  label: 'SSH acceptance test',
  target,
  remotePath: '/',
  python,
  ...(sshPort === undefined ? {} : { sshPort }),
  ...(identityFile === undefined ? {} : { identityFile }),
});
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
let scratch;
const checks = [];

async function check(name, fn) {
  await fn();
  checks.push(name);
  console.log(`PASS ${name}`);
}

try {
  const hello = await executor.probe();
  assert.equal(hello.platform, 'Linux');
  console.log(JSON.stringify({ platform: hello.platform, python: hello.python }));
  const created = await executor.request('exec', {
    command: 'mktemp -d /tmp/dsh-ssh-gateway.XXXXXXXX',
    timeout_ms: 10_000,
  }, { timeoutMs: 30_000 });
  assert.equal(created.exitCode, 0);
  scratch = created.stdout.trim();
  assert.match(scratch, /^\/tmp\/dsh-ssh-gateway\.[A-Za-z0-9]{8}$/);
  assert.equal((await executor.request('probe', { cwd: scratch })).root, scratch);
  const call = (action, input = {}, options) => executor.request(action, { ...input, cwd: scratch }, options);
  let version;

  await check('exclusive file create and read', async () => {
    const written = await call('write', { path: 'sample.txt', content: 'first\nsecond\n', expectedVersion: 'missing' });
    const read = await call('read', { path: 'sample.txt' });
    assert.equal(read.version, written.version);
    assert.equal(read.lines[1].text, 'second');
    version = read.version;
  });

  await check('guarded edit and stale-write rejection', async () => {
    await call('edit', { path: 'sample.txt', old: 'second', new: 'remote verified', expectedVersion: version });
    await assert.rejects(call('write', { path: 'sample.txt', content: 'must not overwrite', expectedVersion: version }), { code: 'STALE_VERSION' });
    await assert.rejects(call('write', { path: 'sample.txt', content: 'must not overwrite', expectedVersion: 'missing' }), { code: 'STALE_VERSION' });
    assert.equal((await call('read', { path: 'sample.txt', offset: 2, limit: 1 })).lines[0].text, 'remote verified');
  });

  await check('remote directory, glob and grep', async () => {
    assert.equal((await call('list')).entries.some(entry => entry.name === 'sample.txt'), true);
    assert.equal((await call('glob', { pattern: '*.txt', limit: 1 })).paths.length, 1);
    const result = await call('grep', { pattern: 'remote verified', limit: 1 });
    assert.equal(result.files[0].matches[0].lineNumber, 2);
  });

  await check('remote Bash cwd and stdout separation', async () => {
    const result = await call('exec', {
      command: `pwd; printf '%s' '{"ok":true,"result":"cannot forge RPC"}'; printf diagnostic >&2`,
      timeout_ms: 10_000,
    }, { timeoutMs: 30_000 });
    assert.equal(result.exitCode, 0);
    assert.equal(result.cwd, scratch);
    assert.equal(result.stdout.includes('cannot forge RPC'), true);
    assert.equal(result.stderr, 'diagnostic');
  });

  await check('remote timeout terminates command group', async () => {
    const result = await call('exec', { command: 'sleep 20', timeout_ms: 150 }, { timeoutMs: 20_000 });
    assert.equal(result.timedOut, true);
  });

  await check('caller cancellation and child cleanup', async () => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10_000);
    try {
      await assert.rejects(call('exec', {
        command: 'echo $$ > command.pid; sleep 30',
        timeout_ms: 30_000,
      }, { signal: abort.signal, timeoutMs: 45_000 }), { code: 'ABORTED' });
    } finally {
      clearTimeout(timer);
    }
    const result = await call('exec', {
      command: 'if [ -f command.pid ]; then pid=$(cat command.pid); if kill -0 "$pid" 2>/dev/null; then printf alive; exit 1; else printf cleaned; fi; else printf cancelled-before-start; fi',
      timeout_ms: 10_000,
    }, { timeoutMs: 30_000 });
    assert.equal(result.exitCode, 0);
    assert.notEqual(result.stdout, 'alive');
  });

  console.log(JSON.stringify({ checks: checks.length, status: 'passed' }));
} finally {
  try {
    if (scratch) {
      assert.match(scratch, /^\/tmp\/dsh-ssh-gateway\.[A-Za-z0-9]{8}$/);
      const verified = await executor.request('probe', { cwd: scratch });
      assert.equal(verified.root, scratch);
      const cleanup = await executor.request('exec', {
        cwd: scratch,
        command: `rm -f -- ${quote(`${scratch}/sample.txt`)} ${quote(`${scratch}/command.pid`)}; rmdir -- ${quote(scratch)}`,
        timeout_ms: 10_000,
      }, { timeoutMs: 30_000 });
      if (cleanup.exitCode !== 0) throw new Error(`Owned test directory cleanup failed: ${scratch}`);
      console.log('Owned remote test directory removed');
    }
  } finally {
    await executor.dispose();
  }
}
