import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../sidebar-adapter/', import.meta.url);
const specs = [
  ['lib/index.js', [
    ['function writeError(res, error) {', 'function writeError(res, error) {\n\tif (error instanceof Error && typeof error.code === "string" && error.code.startsWith("remote-") && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) { writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } }); return; }'],
    ['const inject = [\n', 'const inject = [\n\t"sshWorkspaceFiles",\n'],
    ['async function sessionCwdOf(ctx, sessionId, clientCwd) {', 'async function sessionCwdOf(ctx, sessionId, clientCwd) {\n\tawait ctx.sshWorkspaceFiles.guard(sessionId);'],
    ['const controller = method === "changes.ops" ? new AbortController() : void 0;', 'const controller = new AbortController();'],
    ['const payload = await readJsonBody(req);\n', 'const payload = await readJsonBody(req);\n\t\t\t\tconst remote = await ctx.sshWorkspaceFiles.api(method, payload, controller.signal);\n\t\t\t\tif (remote.handled) { if (!controller.signal.aborted) writeOk(res, remote.value); return; }\n'],
    ['const path = await ensureWorkspacePath(await activeWorktreeRootOf(ctx, sessionId, await sessionCwdOf(ctx, sessionId, url.searchParams.get("cwd") ?? void 0)), raw);', 'if (await ctx.sshWorkspaceFiles.media(sessionId, raw, res, { mediaType: mediaTypeForPath(raw), download: url.searchParams.get("download") === "1" })) return;\n\t\t\t\tconst path = await ensureWorkspacePath(await activeWorktreeRootOf(ctx, sessionId, await sessionCwdOf(ctx, sessionId, url.searchParams.get("cwd") ?? void 0)), raw);'],
    ['const { sessionId, path } = decoded.ref;\n', 'const { sessionId, path } = decoded.ref;\n\t\t\t\tif (await ctx.sshWorkspaceFiles.media(sessionId, path, res, { html: true, mediaType: mediaTypeForPath(path) })) return;\n'],
    ['await respondArchiveDownload(archiveTasks, {', 'await ctx.sshWorkspaceFiles.guard(url.searchParams.get("sessionId"));\n\t\t\t\tawait respondArchiveDownload(archiveTasks, {'],
    ['async function attachFsWatch(ctx, ws, req) {\n\ttry {', 'async function attachFsWatch(ctx, ws, req) {\n\ttry {\n\t\tif (await ctx.sshWorkspaceFiles.watch(ws, req)) return;\n\t\tconst offRemoteBinding = ctx.sshWorkspaceFiles.subscribeBindings(() => ws.close(1012, "Workspace binding changed"));\n\t\tws.once("close", offRemoteBinding);']
  ]],
  ['src/index.ts', [
    ["import { MAX_EDITABLE_BYTES, PAGE_BYTES, WRITE_BODY_GUARD_BYTES } from './editor-limits.ts'", "import { MAX_EDITABLE_BYTES, PAGE_BYTES, WRITE_BODY_GUARD_BYTES } from './editor-limits.ts'\nimport type {} from './ssh-files-backend.ts'"],
    ["export const inject = [", "export const inject = ['sshWorkspaceFiles', "],
    ['async function sessionCwdOf(ctx: Context, sessionId: string, clientCwd?: string): Promise<string> {', 'async function sessionCwdOf(ctx: Context, sessionId: string, clientCwd?: string): Promise<string> {\n  await ctx.sshWorkspaceFiles.guard(sessionId)'],
    ["const controller = method === 'changes.ops' ? new AbortController() : undefined", 'const controller = new AbortController()'],
    ['const payload = await readJsonBody(req)\n', 'const payload = await readJsonBody(req)\n        const remote = await ctx.sshWorkspaceFiles.api(method, payload, controller.signal)\n        if (remote.handled) { if (!controller.signal.aborted) writeOk(res, remote.value); return }\n'],
    ["if (sessionId === null || raw === null) throw new SidebarError('bad-request', 'sessionId and path are required')", "if (sessionId === null || raw === null) throw new SidebarError('bad-request', 'sessionId and path are required')\n        if (await ctx.sshWorkspaceFiles.media(sessionId, raw, res, { mediaType: mediaTypeForPath(raw), download: url.searchParams.get('download') === '1' })) return"],
    ['const { sessionId, path } = decoded.ref\n', 'const { sessionId, path } = decoded.ref\n        if (await ctx.sshWorkspaceFiles.media(sessionId, path, res, { html: true, mediaType: mediaTypeForPath(path) })) return\n'],
    ['await respondArchiveDownload(archiveTasks, {', 'await ctx.sshWorkspaceFiles.guard(url.searchParams.get(\'sessionId\'))\n        await respondArchiveDownload(archiveTasks, {'],
    ["async function attachFsWatch(\n  ctx: Context,\n  ws: WebSocket,\n  req: SidebarHttpRequest,\n): Promise<void> {\n  try {", "async function attachFsWatch(\n  ctx: Context,\n  ws: WebSocket,\n  req: SidebarHttpRequest,\n): Promise<void> {\n  try {\n    if (await ctx.sshWorkspaceFiles.watch(ws, req)) return\n    const offRemoteBinding = ctx.sshWorkspaceFiles.subscribeBindings(() => ws.close(1012, 'Workspace binding changed'))\n    ws.once('close', offRemoteBinding)"]
  ]]
];
// A pinned upstream baseline makes the patch repeatable and fails on upstream drift.
for (const [path, changes] of specs) {
  const target = new URL(path, root), baseline = new URL(path + '.upstream', root);
  try { await readFile(baseline); } catch (error) { if (error.code !== 'ENOENT') throw error; await copyFile(target, baseline); }
  let source = await readFile(baseline, 'utf8');
  for (const [before, after] of changes) {
    if (source.split(before).length !== 2) throw new Error(`Expected one patch anchor in ${path}: ${before.slice(0, 100)}`);
    source = source.replace(before, after);
  }
  await writeFile(target, source);
  console.log(`Patched ${fileURLToPath(target)} (${changes.length} hooks)`);
}
