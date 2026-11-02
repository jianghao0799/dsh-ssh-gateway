import { join } from 'node:path';
import { homedir } from 'node:os';
import { RemoteWorkspaceController } from './remote-workspaces.js';
import { installRemoteTools } from './remote-tools.js';
import { RemoteSidebarFiles } from './sidebar-files.js';

export const name = 'dsh-ssh-gateway';
export const inject = ['webServer', 'connection', 'tools', 'systemPrompt', 'agents', 'sessions', 'sessionController', 'workspaceRegistry', 'agentPresets', 'sandboxPolicy', 'attachments'];

export async function apply(ctx) {
  const controller = new RemoteWorkspaceController(process.env.DSH_HOME || join(homedir(), '.dsh'), {
    sessionController: ctx.sessionController, workspaceRegistry: ctx.workspaceRegistry,
    sessions: ctx.sessions, agentPresets: ctx.agentPresets
  });
  await controller.load();
  ctx.effect(() => () => controller.dispose());
  const sidebarFiles = new RemoteSidebarFiles(controller);
  ctx.effect(() => () => sidebarFiles.dispose());
  ctx.provide('sshWorkspaceFiles', sidebarFiles);
  const removeTools = installRemoteTools(ctx, controller);
  ctx.effect(() => removeTools);
  const admitted = (req, res) => {
    const rejection = ctx.connection.requestRejection(req);
    if (rejection) { res.writeHead(rejection); res.end(); return false; }
    const admission = ctx.connection.admit(req);
    if ('rejection' in admission) { res.writeHead(admission.rejection); res.end(); return false; }
    if (admission.peer.principal.kind !== 'owner') { res.writeHead(403); res.end(); return false; }
    return true;
  };
  const json = (res, value, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/ssh-workspaces/v3/control', async handler(req, res) {
    if (!admitted(req, res)) return;
    const abort = new AbortController();
    const closed = () => { if (!res.writableEnded) abort.abort(); };
    res.once('close', closed);
    try {
      if (req.method === 'GET') {
        const id = new URL(req.url, 'http://localhost').searchParams.get('sessionId');
        json(res, { ok: true, value: id ? { binding: await controller.bindingFor(id) } : controller.snapshot() }); return;
      }
      if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); json(res, { ok: false, error: 'Use GET or POST' }, 405); return; }
      if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') { json(res, { ok: false, error: 'Use application/json' }, 415); return; }
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 32768) { json(res, { ok: false, error: 'Request is too large' }, 413); return; }
        chunks.push(chunk);
      }
      const { action, input } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const value = await controller.execute(action, input, { signal: abort.signal });
      if (!res.destroyed) json(res, { ok: true, value });
    } catch (error) {
      if (!res.destroyed) json(res, { ok: false, error: error instanceof Error ? error.message : 'SSH workspace operation failed' }, 400);
    } finally { res.off('close', closed); }
  }}));
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/ssh-workspaces/v3/catalog', async handler(req, res) {
    if (!admitted(req, res)) return;
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); json(res, { ok: false, error: 'Use GET' }, 405); return; }
    try { json(res, { ok: true, value: await controller.catalog() }); }
    catch { json(res, { ok: false, error: 'Unable to load local sessions and presets' }, 502); }
  }}));
}
