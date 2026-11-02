import { posix, win32 } from 'node:path';
import { once } from 'node:events';

const failure = (code, message, status = 400) => Object.assign(new Error(message), { code: code.startsWith('remote-') ? code : `remote-${code}`, status });
const fileMethods = method => method === 'session.cwd' || /^(fs\.|git\.|archive\.|changes\.)/.test(method) || method === 'open.external';
const PATH_LIMIT = 64;
function pathOf(value, root) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/.test(value) || /^[A-Za-z]:|^\\/.test(value)) throw failure('bad-request', 'A remote POSIX file path is required');
  return posix.resolve(root, value);
}

/** Session-aware backend consumed by the maintained Better Sidebar Host adapter. */
export class RemoteSidebarFiles {
  constructor(controller, { watchIntervalMs = 8000 } = {}) {
    this.controller = controller; this.watchIntervalMs = watchIntervalMs; this.sockets = new Set(); this.closed = false;
  }
  async binding(sessionId) {
    if (this.closed) throw failure('remote-unavailable', 'SSH file backend is stopping', 503);
    return typeof sessionId === 'string' ? this.controller.bindingFor(sessionId) : null;
  }
  subscribeBindings(listener) { return this.controller.subscribeBindings(listener); }
  async request(sessionId, action, input, signal) {
    try { return await this.controller.requestFor(sessionId, action, input, { signal, timeoutMs: 60000 }); }
    catch (error) {
      const status = { NOT_FOUND: 404, PERMISSION_DENIED: 403, TOO_LARGE: 413, STALE_VERSION: 409, INVALID_REQUEST: 400, ABORTED: 499 }[error.code] || 503;
      throw failure('remote-io', error.message, status);
    }
  }
  async addressResolver(sessionId, root) {
    let localBase = this.controller.sessions?.get(sessionId)?.header?.cwd;
    // A cold session still has stored address metadata; inspect without resuming it.
    if (!localBase && this.controller.sessionController?.inspect) {
      localBase = (await this.controller.sessionController.inspect(sessionId))?.meta?.cwd;
    }
    return (value, base = root) => {
      if (typeof value === 'string' && !/[\x00-\x1f\x7f]/.test(value) && /^[A-Za-z]:|^\\\\/.test(value) && typeof localBase === 'string') {
        const relative = win32.relative(localBase, value);
        if (relative !== '..' && !relative.startsWith('..\\') && !win32.isAbsolute(relative)) {
          return posix.resolve(root, relative.replaceAll('\\', '/'));
        }
      }
      return pathOf(value, base);
    };
  }
  async api(method, payload, signal) {
    if (!fileMethods(method)) return { handled: false };
    const sessionId = payload?.sessionId;
    const binding = await this.binding(sessionId);
    if (!binding) return { handled: false };
    const root = binding.root;
    if (method === 'session.cwd') return { handled: true, value: { sessionId, cwd: root, root: posix.basename(root) || '/', parent: root === '/' ? null : posix.dirname(root) } };
    if (!binding.connected) throw failure('remote-disconnected', 'SSH 工作区已断开，请先在 SSH 工作区面板重新连接。', 503);
    const resolveAddress = ['fs.read', 'fs.readPage'].includes(method) ? await this.addressResolver(sessionId, root) : pathOf;
    const base = payload?.repoRoot == null || payload.repoRoot === '' ? root : resolveAddress(payload.repoRoot, root);
    const request = (action, input) => this.request(sessionId, action, { ...input, cwd: root }, signal);
    let value;
    switch (method) {
      case 'fs.tree': value = await request('sidebar_tree', { path: pathOf(payload.path, root), exclude: payload.exclude }); break;
      case 'fs.trees': {
        if (!Array.isArray(payload.paths) || payload.paths.length < 1 || payload.paths.length > PATH_LIMIT) throw failure('bad-request', 'paths must contain 1–64 remote directories');
        // Bound the SSH fan-out: expanded levels are intentionally read in sequence.
        const levels = [];
        for (const raw of payload.paths) {
          const path = pathOf(raw, root);
          try { levels.push(await request('sidebar_tree', { path, exclude: payload.exclude })); }
          catch (error) { if (signal?.aborted) throw error; levels.push({ path, entries: [], truncated: false, error: error.message }); }
        }
        value = { levels }; break;
      }
      case 'fs.read': value = await request('sidebar_read', { path: resolveAddress(payload.path, base) }); break;
      case 'fs.readPage': value = await request('sidebar_read_page', { path: resolveAddress(payload.path, base), offset: payload.offset ?? 0 }); break;
      case 'fs.search': value = await request('sidebar_search', { query: payload.query, exclude: payload.exclude }); break;
      default: throw failure('remote-unsupported', '此 SSH 文件视图暂不支持该操作。请通过远程会话工具执行文件修改或 Git 操作。', 501);
    }
    return { handled: true, value };
  }
  async guard(sessionId) {
    if (await this.binding(sessionId)) throw failure('remote-unsupported', '此侧栏操作尚未适配 SSH 工作区，请使用远程会话工具。', 501);
  }
  async media(sessionId, raw, res, options = {}) {
    const abort = new AbortController();
    const closed = () => { if (!res.writableEnded) abort.abort(); };
    res.once('close', closed);
    try { return await this.streamMedia(sessionId, raw, res, { ...options, signal: options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal }); }
    finally { res.off('close', closed); }
  }
  async streamMedia(sessionId, raw, res, { html = false, download = false, mediaType, signal } = {}) {
    const binding = await this.binding(sessionId);
    if (!binding) return false;
    if (!binding.connected) throw failure('remote-disconnected', 'SSH workspace is disconnected; reconnect it before opening remote files.', 503);
    const path = (await this.addressResolver(sessionId, binding.root))(raw);
    const info = await this.request(sessionId, 'sidebar_stat', { path, cwd: binding.root }, signal);
    if (!info.isFile) throw failure('fs-error', 'Remote path is not a regular file');
    const type = mediaType || 'application/octet-stream';
    const headers = { 'content-type': html && type === 'text/html' ? 'text/html; charset=utf-8' : type,
      'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-length': String(info.size) };
    if (html || type === 'text/html' || type === 'application/xhtml+xml') headers['content-security-policy'] = "sandbox allow-scripts allow-popups allow-downloads allow-modals; object-src 'none'";
    else if (type === 'image/svg+xml') headers['content-security-policy'] = "sandbox; object-src 'none'";
    if (download) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(posix.basename(path)).replaceAll("'", '%27')}`;
    let offset = 0;
    try {
      // Fetch the first window before sending headers, so ordinary read errors keep the JSON error envelope.
      do {
        const page = await this.request(sessionId, 'sidebar_read_binary_page', { path, cwd: binding.root, offset, limit: 1048576, expectedMtimeMs: info.mtimeMs, expectedSize: info.size }, signal);
        const bytes = Buffer.from(page.data, 'base64');
        if (page.offset !== offset || page.nextOffset !== offset + bytes.length || page.nextOffset > info.size || (!page.eof && bytes.length === 0)) throw failure('remote-protocol', 'Invalid remote file window', 502);
        if (signal?.aborted || res.destroyed) throw failure('cancelled', 'Remote preview cancelled', 499);
        if (!res.headersSent) res.writeHead(200, headers);
        if (!res.write(bytes)) await once(res, 'drain', { signal });
        offset = page.nextOffset;
        if (page.eof) { if (offset !== info.size) throw failure('remote-changed', 'Remote file changed while opening', 409); break; }
      } while (offset < info.size);
      res.end();
      return true;
    } catch (error) { if (res.headersSent) { res.destroy(error); return true; } throw error; }
  }
  async watch(ws, req) {
    // Attach before the first asynchronous binding lookup; an eager client may announce paths immediately.
    const queued = []; let gone = ws.readyState !== 1;
    const markClosed = () => { gone = true; };
    const enqueue = data => { if (queued.length >= 64 || data.length > 16384) { gone = true; ws.close(1009, 'Watch queue limit'); } else queued.push(data); };
    const detachEarly = () => { ws.off('message', enqueue); ws.off('close', markClosed); ws.off('error', markClosed); };
    ws.once('close', markClosed); ws.once('error', markClosed); ws.on('message', enqueue);
    const sessionId = new URL(req.url || '/', 'http://localhost').searchParams.get('sessionId');
    let binding;
    try { binding = await this.binding(sessionId); }
    catch { detachEarly(); if (!gone) ws.close(1013, 'SSH workspace unavailable'); return true; }
    if (gone || ws.readyState !== 1) { detachEarly(); return true; }
    if (!binding) {
      detachEarly();
      if (queued.length) setImmediate(() => { if (ws.readyState === 1) queued.forEach(data => ws.emit('message', data)); });
      return false;
    }
    const watched = new Map(); const abort = new AbortController();
    let stopped = false, timer, running = false, frames = Promise.resolve();
    const send = value => { if (!stopped && ws.readyState === 1) ws.send(JSON.stringify(value)); };
    const stop = () => { if (stopped) return; stopped = true; clearTimeout(timer); abort.abort(); this.sockets.delete(close); offBindings(); ws.off('message', frame); };
    const close = () => { stop(); ws.close(1012, 'SSH workspace changed'); };
    const offBindings = this.subscribeBindings(close);
    const poll = async () => {
      if (stopped || running) return;
      running = true;
      try {
        if (watched.size) {
          const value = await this.request(sessionId, 'sidebar_watch_snapshot', { paths: [...watched.keys()], cwd: binding.root }, abort.signal);
          for (const level of value.levels) {
            if (!watched.has(level.dir)) continue;
            const previous = watched.get(level.dir), next = level.error || level.fingerprint;
            watched.set(level.dir, next);
            if (previous !== undefined && previous !== next) send({ dir: level.dir });
          }
        }
      } catch { if (!stopped) { for (const dir of watched.keys()) send({ dir }); close(); } }
      finally { running = false; if (!stopped) { timer = setTimeout(poll, this.watchIntervalMs); timer.unref?.(); } }
    };
    const frame = data => {
      frames = frames.then(async () => {
        if (stopped) return;
        let raw;
        try {
          if (data.length > 16384) throw failure('bad-request', 'Watch frame too large');
          raw = JSON.parse(String(data));
          const dir = pathOf(raw.path, binding.root);
          if (raw.op === 'unwatch') { watched.delete(dir); return; }
          if (raw.op !== 'watch') throw failure('bad-request', 'Unknown watch operation');
          if (watched.has(dir)) { send({ dir, ok: true }); return; }
          if (watched.size >= PATH_LIMIT) throw failure('watch-limit', 'At most 64 expanded directories can be watched');
          if (!(await this.binding(sessionId))?.connected) throw failure('remote-disconnected', 'SSH workspace disconnected');
          const value = await this.request(sessionId, 'sidebar_watch_snapshot', { paths: [dir], cwd: binding.root }, abort.signal);
          const level = value.levels[0];
          if (!level || level.error) throw failure('fs-error', level?.error || 'Remote directory unavailable');
          watched.set(dir, level.fingerprint); send({ dir, ok: true });
        } catch (error) { send({ dir: raw?.path ?? '', ok: false, reason: error.message }); }
      }).catch(close);
    };
    this.sockets.add(close); ws.once('close', stop); ws.once('error', stop);
    detachEarly(); ws.on('message', frame); queued.forEach(frame);
    timer = setTimeout(poll, this.watchIntervalMs); timer.unref?.();
    if (!binding.connected) close();
    return true;
  }
  dispose() { this.closed = true; for (const stop of [...this.sockets]) stop(); }
}
