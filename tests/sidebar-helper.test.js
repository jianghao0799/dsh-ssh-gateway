import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteExecutor, PYTHON_BOOTSTRAP } from '../remote-executor.js';
const python = process.env.DSH_TEST_PYTHON || (process.platform === 'win32' ? 'C:\\Users\\Jhin\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe' : 'python3');
const available = spawnSync(python, ['--version'], { stdio: 'ignore' }).status === 0;
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'sidebar-helper-'));
  const executor = new RemoteExecutor({ id: 'test', label: 'Test', target: 'user@host', remotePath: '/tmp' }, {
    spawn(_command, _args, options) { return spawn(python, ['-u', '-c', PYTHON_BOOTSTRAP], options); },
  });
  executor.config.remotePath = root;
  t.after(async () => { await executor.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, request: (action, input = {}) => executor.request(action, input) };
}
test('sidebar tree excludes hidden subtrees, preserves rows and fingerprints changes', { skip: !available }, async t => {
  const { root, request } = await setup(t);
  await mkdir(join(root, 'z-dir'));
  await mkdir(join(root, '.git'));
  await writeFile(join(root, '.git', 'config'), 'secret');
  await writeFile(join(root, 'a.txt'), 'hello');
  await writeFile(join(root, '.hidden'), 'hidden');
  const input = { exclude: ['**/.git/**'] };
  const first = await request('sidebar_tree', input);
  assert.deepEqual(first.entries.map(e => e.name), ['z-dir', '.hidden', 'a.txt']);
  assert.equal(first.entries[0].isDir, true);
  assert.equal(first.entries[1].hidden, true);
  assert.equal(first.entries[2].isSymlink, false);
  assert.equal(first.truncated, false);
  assert.equal((await request('sidebar_tree', input)).fingerprint, first.fingerprint);
  await writeFile(join(root, 'a.txt'), 'a changed document');
  assert.notEqual((await request('sidebar_tree', input)).fingerprint, first.fingerprint);
  const stat = await request('sidebar_stat', { path: 'a.txt' });
  assert.equal(stat.size, 18); assert.equal(stat.isDir, false); assert.equal(stat.isFile, true); assert.equal(typeof stat.mtimeMs, 'number');
  for (const action of ['sidebar_read', 'sidebar_read_page', 'sidebar_read_binary_page']) {
    await assert.rejects(request(action, { path: 'z-dir' }), { code: 'INVALID_REQUEST' });
  }
  const snapshot = await request('sidebar_watch_snapshot', { paths: [root, join(root, 'absent')], exclude: input.exclude });
  assert.equal(snapshot.levels[0].fingerprint, (await request('sidebar_tree', input)).fingerprint);
  assert.equal(snapshot.levels[1].error, 'FileNotFoundError');
  await assert.rejects(request('sidebar_watch_snapshot', { paths: Array(65).fill(root) }), { code: 'INVALID_REQUEST' });
  await assert.rejects(request('sidebar_watch_snapshot', { paths: ['relative'] }), { code: 'INVALID_REQUEST' });
});
test('sidebar tree caps wide directories and fingerprints changes beyond the cap', { skip: !available }, async t => {
  const { root, request } = await setup(t);
  for (let i = 0; i < 1005; i++) await writeFile(join(root, `entry-${i}`), '');
  const first = await request('sidebar_tree');
  assert.equal(first.entries.length, 1000); assert.equal(first.truncated, true);
  assert.equal((await request('sidebar_tree')).fingerprint, first.fingerprint);
  await writeFile(join(root, 'another-entry'), '');
  // Force a distinct directory stamp even on filesystems with coarse clock resolution.
  await utimes(root, new Date(), new Date(Date.now() + 5000));
  assert.notEqual((await request('sidebar_tree')).fingerprint, first.fingerprint);
});
test('sidebar symlinks describe directory targets and broken links', { skip: !available }, async t => {
  const { root, request } = await setup(t);
  await mkdir(join(root, 'target'));
  try {
    await symlink(join(root, 'target'), join(root, 'link'), 'dir');
    await symlink(join(root, 'missing'), join(root, 'broken'), 'file');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Windows symlink privilege unavailable'); return; }
    throw error;
  }
  const rows = (await request('sidebar_tree')).entries;
  assert.equal(rows.find(e => e.name === 'link').isDir, true);
  assert.equal(rows.find(e => e.name === 'link').isSymlink, true);
  assert.equal(rows.find(e => e.name === 'broken').broken, true);
  assert.equal(rows.find(e => e.name === 'broken').isDir, false);
});
test('sidebar reads distinguish text binary and large files; paged UTF-8 round trips', { skip: !available }, async t => {
  const { root, request } = await setup(t);
  await writeFile(join(root, 'text.txt'), 'hello 世界\n');
  assert.equal((await request('sidebar_read', { path: 'text.txt' })).content, 'hello 世界\n');
  await writeFile(join(root, 'binary'), Buffer.from([1, 0, 255]));
  const binary = await request('sidebar_read', { path: 'binary' });
  assert.equal(binary.kind, 'binary'); assert.deepEqual(Buffer.from(binary.head, 'base64'), Buffer.from([1, 0, 255]));
  assert.equal((await request('sidebar_read_page', { path: 'binary' })).kind, 'binary');
  const content = '你好 long line with unicode\n'.repeat(40000);
  await writeFile(join(root, 'large.txt'), content);
  const large = await request('sidebar_read', { path: 'large.txt' });
  assert.equal(large.kind, 'too-large'); assert.equal(Buffer.from(large.head, 'base64').length, 4096); assert.equal(large.content, undefined);
  let offset = 0, result = '';
  do {
    const page = await request('sidebar_read_page', { path: 'large.txt', offset });
    assert.equal(page.offset, offset); assert.equal(page.encoding, 'utf-8');
    assert.ok(page.nextOffset - offset <= 256 * 1024); assert.ok(page.nextOffset > offset);
    if (!page.eof) assert.ok(page.text.endsWith('\n'));
    result += page.text; offset = page.nextOffset;
    if (page.eof) break;
  } while (true);
  assert.equal(result, content);
  assert.equal((await request('sidebar_read_page', { path: 'large.txt', offset: offset + 100 })).text, '');
  await assert.rejects(request('sidebar_read_page', { path: 'large.txt', offset: -1 }), { code: 'INVALID_REQUEST' });
});
test('sidebar binary pages concatenate exactly and reject changed file versions', { skip: !available }, async t => {
  const { root, request } = await setup(t);
  const data = Buffer.alloc(1100000); for (let i = 0; i < data.length; i++) data[i] = i % 251;
  await writeFile(join(root, 'bytes'), data);
  const stat = await request('sidebar_stat', { path: 'bytes' });
  let offset = 0; const chunks = [];
  do {
    const page = await request('sidebar_read_binary_page', { path: 'bytes', offset, limit: 400000, expectedSize: stat.size, expectedMtimeMs: stat.mtimeMs });
    chunks.push(Buffer.from(page.data, 'base64')); assert.equal(page.offset, offset); offset = page.nextOffset;
    if (page.eof) break;
  } while (true);
  assert.deepEqual(Buffer.concat(chunks), data);
  await assert.rejects(request('sidebar_read_binary_page', { path: 'bytes', limit: 1048577 }), { code: 'INVALID_REQUEST' });
  await assert.rejects(request('sidebar_read_binary_page', { path: 'bytes', expectedSize: stat.size + 1 }), { code: 'STALE_VERSION' });
  await utimes(join(root, 'bytes'), new Date(), new Date(Date.now() + 5000));
  await assert.rejects(request('sidebar_read_binary_page', { path: 'bytes', expectedMtimeMs: stat.mtimeMs }), { code: 'STALE_VERSION' });
});
test('sidebar search prunes excludes, matches names and path fragments and bounds results', { skip: !available }, async t => {
  const { root, request } = await setup(t);
  await mkdir(join(root, '.git')); await writeFile(join(root, '.git', 'Needle'), '');
  await mkdir(join(root, 'nested')); await writeFile(join(root, 'nested', 'Needle.txt'), '');
  const found = await request('sidebar_search', { query: 'NEEDLE', exclude: ['**/.git/**'] });
  assert.deepEqual(found.matches, [join(root, 'nested', 'Needle.txt')]);
  assert.equal((await request('sidebar_search', { query: 'nested/needle' })).matches.length, 1);
  assert.deepEqual((await request('sidebar_search', { query: './nested' })).dirs, [join(root, 'nested')]);
  for (let i = 0; i < 505; i++) await writeFile(join(root, `match-${i}`), '');
  const bounded = await request('sidebar_search', { query: 'match-' });
  assert.equal(bounded.matches.length, 500); assert.equal(bounded.truncated, true);
});
