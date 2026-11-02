import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RemoteExecutor, validateRemoteTarget } from './remote-executor.js';

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value);
const CONNECT_ATTEMPTS = 3;
const RETRYABLE_CONNECT_CODES = new Set(['SSH_FAILED', 'TIMEOUT']);
function remotePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\x00-\x1f\x7f]/.test(value)) throw new Error('A remote absolute POSIX path is required');
  return value;
}

export class RemoteWorkspaceController {
  constructor(home, { executorFactory = config => new RemoteExecutor(config), sessionController, workspaceRegistry, sessions, agentPresets } = {}) {
    this.home = resolve(home);
    this.file = join(this.home, 'ssh-workspaces', 'state.json');
    this.executorFactory = executorFactory;
    this.sessionController = sessionController;
    this.workspaceRegistry = workspaceRegistry;
    this.sessions = sessions;
    this.agentPresets = agentPresets;
    this.targets = new Map(); this.bindings = new Map(); this.workspaces = new Map();
    this.engines = new Map(); this.states = new Map(); this.listeners = new Set();
    this.busy = false; this.closed = false;
  }
  async load() {
    let data;
    try { data = JSON.parse(await readFile(this.file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (data.version !== 1 || !Array.isArray(data.targets) || !Array.isArray(data.bindings) || !Array.isArray(data.workspaces)) throw new Error('Invalid SSH workspace store');
    const targets = new Map(), bindings = new Map(), workspaces = new Map();
    for (const value of data.targets) {
      if (!identifier(value.id)) throw new Error('Invalid stored target id');
      const target = validateRemoteTarget(value); targets.set(target.id, target);
    }
    for (const binding of data.bindings) {
      if (!identifier(binding.sessionId) || !targets.has(binding.targetId)) throw new Error('Invalid stored session binding');
      bindings.set(binding.sessionId, { sessionId: binding.sessionId, targetId: binding.targetId, root: remotePath(binding.root), disabled: binding.disabled === true });
    }
    for (const workspace of data.workspaces) {
      if (!targets.has(workspace.targetId)) throw new Error('Unknown stored workspace target');
      const expected = join(this.home, 'ssh-workspaces', 'anchors', workspace.targetId);
      if (resolve(workspace.anchorPath) !== resolve(expected)) throw new Error('Invalid local workspace anchor');
      workspaces.set(workspace.targetId, { targetId: workspace.targetId, anchorPath: expected, root: remotePath(workspace.root), ...(workspace.workspaceId ? { workspaceId: workspace.workspaceId } : {}) });
    }
    this.targets = targets; this.bindings = bindings; this.workspaces = workspaces;
  }
  snapshot() {
    const bindings = [...this.bindings.values()].filter(b => !b.disabled).map(b => ({ ...b }));
    const seen = new Set(this.bindings.keys());
    for (const anchor of this.workspaces.values()) {
      const workspace = anchor.workspaceId ? this.workspaceRegistry?.get?.(anchor.workspaceId) : undefined;
      for (const sessionId of workspace?.sessionIds || []) {
        if (seen.has(sessionId)) continue;
        seen.add(sessionId);
        bindings.push({ sessionId, targetId: anchor.targetId, root: anchor.root, source: 'workspace' });
      }
    }
    return { mode: 'local-harness-remote-execution', busy: this.busy,
      targets: [...this.targets.values()].map(target => ({ ...target, connection: this.states.get(target.id) || { status: 'disconnected' }, workspace: this.workspaces.get(target.id) || null })),
      bindings };
  }
  subscribeBindings(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async notify(sessionId = null) { await Promise.all([...this.listeners].map(fn => fn(sessionId))); }
  async persist({ targets = this.targets, bindings = this.bindings, workspaces = this.workspaces } = {}) {
    await mkdir(join(this.home, 'ssh-workspaces'), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ version: 1, targets: [...targets.values()], bindings: [...bindings.values()], workspaces: [...workspaces.values()] }, null, 2) + '\n', { mode: 0o600 });
      await rename(temp, this.file);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
    this.targets = targets; this.bindings = bindings; this.workspaces = workspaces;
  }
  target(id) { const target = this.targets.get(id); if (!target) throw new Error('SSH target does not exist'); return target; }
  async bindingFor(sessionId) {
    const visited = new Set();
    let current = sessionId;
    for (let depth = 0; current && depth < 32 && !visited.has(current); depth++) {
      visited.add(current);
      const explicit = this.bindings.get(current);
      if (explicit?.disabled) return null;
      let binding = explicit;
      let header;
      if (!binding) {
        const anchor = [...this.workspaces.values()].find(w => w.workspaceId && this.workspaceRegistry?.get?.(w.workspaceId)?.sessionIds?.includes(current));
        if (anchor) binding = { targetId: anchor.targetId, root: anchor.root };
      }
      if (!binding) {
        header = this.sessions?.get(current)?.header;
        if (!header) {
          if (typeof this.sessionController?.inspect !== 'function') throw new Error('Session metadata inspection is unavailable; refusing local filesystem fallback');
          try {
            // inspect is cold-safe: it reads .meta without resuming an Agent.
            // Workspace deletion retains history, so registry membership alone
            // cannot identify a detached session's SSH anchor or parent chain.
            const inspection = await this.sessionController.inspect(current);
            if (!inspection?.meta || typeof inspection.meta !== 'object') throw new Error('Session metadata inspection returned no header; refusing local filesystem fallback');
            header = inspection.meta;
          } catch (error) {
            // The shipped controller exports this Error subclass (not a
            // RemoteError code). Storage, cancellation and corruption failures
            // must propagate instead of making an SSH session look local.
            if (error instanceof Error && error.constructor?.name === 'ApiSessionNotFound') return null;
            throw error;
          }
        }
      }
      if (!binding && header?.cwd) {
        const anchor = [...this.workspaces.values()].find(w => resolve(w.anchorPath) === resolve(header.cwd));
        if (anchor) binding = { targetId: anchor.targetId, root: anchor.root };
      }
      if (binding) {
        const profile = this.targets.get(binding.targetId);
        if (!profile) return null;
        return { profile: { ...profile }, root: binding.root, connected: this.states.get(binding.targetId)?.status === 'ready' && this.engines.has(binding.targetId) };
      }
      current = header?.parentSession;
    }
    return null;
  }
  async requestFor(sessionId, action, input = {}, options = {}) {
    if (this.closed) throw new Error('SSH workspace plugin is stopping');
    const binding = await this.bindingFor(sessionId);
    if (!binding) throw new Error('This local session has no SSH workspace binding');
    const engine = this.engines.get(binding.profile.id);
    if (!binding.connected || !engine) throw new Error('SSH workspace is disconnected; reconnect it in the SSH workspace panel. Do not fall back to local execution.');
    try { return await engine.request(action, { ...input, cwd: input.cwd || binding.root }, options); }
    catch (error) {
      if (error?.connectionLost === true || ['SSH_FAILED', 'TRANSPORT', 'PROTOCOL'].includes(error?.code)) {
        this.engines.delete(binding.profile.id);
        this.states.set(binding.profile.id, { status: 'disconnected', error: 'SSH transport failed; reconnect explicitly' });
        await engine.dispose(); await this.notify();
      }
      throw error;
    }
  }
  async assertIdle(sessionIds) {
    if (!this.sessionController) return;
    const result = await this.sessionController.list({}, new AbortController().signal);
    if (result.items.some(s => s.running && sessionIds.includes(s.sessionId))) throw new Error('Wait for the local session to become idle before changing its SSH binding');
  }
  async catalog() {
    const listed = this.sessionController ? await this.sessionController.list({}, new AbortController().signal) : { items: [] };
    return { sessions: listed.items.slice(0, 100).map(s => ({ sessionId: s.sessionId, cwd: s.cwd, running: s.running, blank: s.blank })),
      presets: this.agentPresets ? (await this.agentPresets.list()).map(p => ({ id: p.id, name: p.name, broken: p.broken })) : [] };
  }
  async connect(id, signal) {
    const target = this.target(id);
    await this.engines.get(id)?.dispose(); this.engines.delete(id);
    this.states.set(id, { status: 'connecting' });
    let lastError;
    for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
      const engine = this.executorFactory(target);
      try {
        const hello = await engine.probe({ signal });
        const root = remotePath(hello.root);
        const roots = [...this.bindings.values()].filter(b => b.targetId === id && !b.disabled).map(b => b.root);
        if (this.workspaces.has(id)) roots.push(this.workspaces.get(id).root);
        if (roots.some(saved => saved !== root)) throw new Error('SSH canonical root changed; saved sessions must keep a stable execution root');
        if (this.closed) throw new Error('SSH workspace plugin is stopping');
        this.engines.set(id, engine);
        this.states.set(id, { status: 'ready', root, hostname: hello.hostname, platform: hello.platform });
        await this.notify();
        return this.snapshot();
      } catch (error) {
        lastError = error;
        await engine.dispose();
        if (signal?.aborted || this.closed || !RETRYABLE_CONNECT_CODES.has(error?.code) || attempt === CONNECT_ATTEMPTS) break;
      }
    }
    this.engines.delete(id);
    this.states.set(id, { status: 'error', error: lastError?.message || 'SSH workspace connection failed' });
    await this.notify();
    throw lastError;
  }
  async execute(action, input = {}, { signal } = {}) {
    if (this.closed) throw new Error('SSH workspace plugin is stopping');
    if (this.busy) throw new Error('Another SSH workspace operation is in progress');
    this.busy = true;
    try {
      if (action === 'save') {
        const id = input.id || randomUUID();
        if (!identifier(id)) throw new Error('Invalid SSH target id');
        const target = validateRemoteTarget({ ...input, id, ...(input.identityFile === '' ? { identityFile: undefined } : {}), ...(input.sshPort === '' || input.sshPort == null ? { sshPort: undefined } : {}) });
        const used = this.workspaces.has(id) || [...this.bindings.values()].some(b => b.targetId === id && !b.disabled);
        if (used && this.targets.has(id) && JSON.stringify(this.targets.get(id)) !== JSON.stringify(target)) throw new Error('Remove this target’s session bindings before editing it; saved sessions must keep a stable execution target');
        if (this.engines.has(id)) throw new Error('Disconnect before editing the target');
        await this.persist({ targets: new Map(this.targets).set(id, target) });
      } else if (action === 'connect') return await this.connect(input.id, signal);
      else if (action === 'disconnect') {
        this.target(input.id); const engine = this.engines.get(input.id); this.engines.delete(input.id);
        this.states.set(input.id, { status: 'disconnected' });
        await engine?.dispose(); await this.notify();
      } else if (action === 'delete') {
        this.target(input.id);
        if ([...this.bindings.values()].some(b => b.targetId === input.id && !b.disabled) || this.workspaces.has(input.id)) throw new Error('This target is used by local sessions or a workspace; keep it saved and disconnect it instead');
        const targets = new Map(this.targets), bindings = new Map(this.bindings);
        targets.delete(input.id);
        for (const [sessionId, binding] of bindings) if (binding.targetId === input.id) bindings.delete(sessionId);
        await this.persist({ targets, bindings });
        const engine = this.engines.get(input.id); this.engines.delete(input.id); this.states.delete(input.id);
        await engine?.dispose(); await this.notify();
      } else if (action === 'create_session') {
        const target = this.target(input.id), state = this.states.get(input.id);
        if (state?.status !== 'ready' || !this.engines.has(input.id)) throw new Error('Connect and verify the SSH target first');
        if (!this.sessionController || !this.workspaceRegistry) throw new Error('Local session services are unavailable');
        let anchor = this.workspaces.get(input.id);
        if (!anchor) {
          anchor = { targetId: input.id, anchorPath: join(this.home, 'ssh-workspaces', 'anchors', input.id), root: state.root };
          await mkdir(anchor.anchorPath, { recursive: true });
          await writeFile(join(anchor.anchorPath, 'REMOTE-WORKSPACE.txt'), `This is local metadata for SSH workspace ${target.label}.\nRemote files: ${state.root}\nThe Harness, models, skills and memory stay local. This directory is not a remote file mirror.\n`, { flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST') throw e; });
          await this.persist({ workspaces: new Map(this.workspaces).set(input.id, anchor) });
        }
        const workspace = await this.workspaceRegistry.create(anchor.anchorPath, `SSH · ${target.label}`);
        anchor = { ...anchor, workspaceId: workspace.id };
        await this.persist({ workspaces: new Map(this.workspaces).set(input.id, anchor) });
        const result = await this.sessionController.create({ workspaceId: workspace.id, ...(input.agentPreset !== undefined ? { agentPreset: input.agentPreset } : {}) });
        if (result?.error) throw result.error;
        await this.notify(result.sessionId);
        return { ...this.snapshot(), sessionId: result.sessionId };
      } else if (action === 'bind_session') {
        this.target(input.id);
        if (!identifier(input.sessionId)) throw new Error('Invalid local session id');
        const state = this.states.get(input.id);
        if (state?.status !== 'ready' || !this.engines.has(input.id)) throw new Error('Connect the SSH target before binding a local session');
        await this.assertIdle([input.sessionId]);
        if (!this.sessionController) throw new Error('Local session services are unavailable');
        const inspected = await this.sessionController.inspect(input.sessionId, signal);
        if (!inspected || inspected.error) throw inspected?.error || new Error('Local session does not exist');
        const resolved = await this.sessionController.resolveAgent(input.sessionId);
        if (!resolved || resolved.error) throw resolved?.error || new Error('Unable to resume the local session');
        await this.assertIdle([input.sessionId]);
        const root = this.workspaces.get(input.id)?.root || state.root;
        const existing = await this.bindingFor(input.sessionId);
        if (existing && (existing.profile.id !== input.id || existing.root !== root)) throw new Error('Unbind the local session before changing its stable execution target');
        await this.persist({ bindings: new Map(this.bindings).set(input.sessionId, { sessionId: input.sessionId, targetId: input.id, root }) });
        await this.notify(input.sessionId);
        return { ...this.snapshot(), sessionId: input.sessionId };
      } else if (action === 'unbind_session') {
        if (!identifier(input.sessionId)) throw new Error('Invalid local session id');
        await this.assertIdle([input.sessionId]);
        const binding = await this.bindingFor(input.sessionId);
        if (binding) await this.persist({ bindings: new Map(this.bindings).set(input.sessionId, { sessionId: input.sessionId, targetId: binding.profile.id, root: binding.root, disabled: true }) });
        await this.notify(input.sessionId);
      } else if (action === 'browse') {
        const engine = this.engines.get(input.id);
        if (!engine) throw new Error('Connect the SSH target first');
        return { ...this.snapshot(), listing: await engine.request('list', { path: input.path || this.states.get(input.id).root }, { signal }) };
      } else throw new Error('Unknown SSH workspace operation');
      return this.snapshot();
    } finally { this.busy = false; }
  }
  async dispose() {
    this.closed = true; this.listeners.clear();
    const engines = [...this.engines.values()]; this.engines.clear();
    await Promise.all(engines.map(engine => engine.dispose()));
  }
}
