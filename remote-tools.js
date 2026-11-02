const ACTIONS = ['read', 'write', 'edit', 'list', 'glob', 'grep', 'read_image'];
const READ = new Set(['read', 'list', 'glob', 'grep', 'read_image']);
const fail = (code, message) => Object.assign(new Error(message), { code });
const str = description => ({ type: 'string', description });
const int = description => ({ type: 'integer', description });
const FULL_ACCESS = 'Remote commands and file changes require Full access: the remote Linux host has no implemented OS sandbox. Select Full access in the DSH UI before retrying. This tool never changes permissions.';
function text(value, key, required = false, empty = false) {
  if (value === undefined && !required) return;
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > 8 * 1024 * 1024 || value.includes('\0')) throw fail('INVALID_REQUEST', `Invalid ${key}`);
}
function validate(args, command = false) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('INVALID_REQUEST', 'Expected an object');
  const action = command ? 'exec' : args.action;
  const allowed = { exec: ['command', 'cwd', 'timeout_ms'], read: ['path', 'offset', 'limit'], read_image: ['path'], list: ['path', 'limit'], glob: ['path', 'pattern', 'limit'], grep: ['path', 'pattern', 'include', 'limit'], write: ['path', 'content', 'expected_version'], edit: ['path', 'old_string', 'new_string', 'replace_all', 'expected_version'] }[action];
  if (!allowed) throw fail('INVALID_REQUEST', 'Unknown remote file action');
  for (const key of Object.keys(args)) if (!(key === 'action' && !command) && !allowed.includes(key)) throw fail('INVALID_REQUEST', `Invalid parameter for ${action}: ${key}`);
  const pathKey = command ? 'cwd' : 'path';
  text(args[pathKey], pathKey, ['read', 'write', 'edit', 'read_image'].includes(action));
  if (args[pathKey] !== undefined && (args[pathKey].includes('\\') || /^[A-Za-z]:|^[a-z]+:\/\//i.test(args[pathKey]))) throw fail('INVALID_REQUEST', `${pathKey} must use remote POSIX path syntax`);
  for (const [key, max] of [['offset', 2147483647], ['limit', 2000], ['timeout_ms', 600000]]) if (args[key] !== undefined && (!Number.isInteger(args[key]) || args[key] < 1 || args[key] > max)) throw fail('INVALID_REQUEST', `${key} must be an integer from 1 to ${max}`);
  text(args.command, 'command', command);
  text(args.pattern, 'pattern', ['glob', 'grep'].includes(action));
  text(args.include, 'include');
  text(args.content, 'content', action === 'write', true);
  text(args.old_string, 'old_string', action === 'edit');
  text(args.new_string, 'new_string', action === 'edit', true);
  text(args.expected_version, 'expected_version', ['write', 'edit'].includes(action));
  if (args.expected_version?.length > 256) throw fail('INVALID_REQUEST', 'Invalid expected_version');
  if (args.replace_all !== undefined && typeof args.replace_all !== 'boolean') throw fail('INVALID_REQUEST', 'replace_all must be a boolean');
  if (action === 'edit' && (args.expected_version === 'missing' || args.old_string === args.new_string)) throw fail('INVALID_REQUEST', 'Editing requires a prior read version and a changed replacement');
  return Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'action'));
}
function render(_args, value) {
  const { attachment, ...rest } = value;
  const json = JSON.stringify(rest);
  const text = json.length <= 24000 ? json : `${json.slice(0, 23800)}\n[Output truncated; narrow the path/pattern or use read offset/limit for a smaller window.]`;
  return [{ type: 'text', text }, ...(attachment ? [{ type: 'image', attachment }] : [])];
}
const output = { schema: { type: 'object', additionalProperties: true }, render };
function context(binding) {
  return `SSH remote workspace: ${JSON.stringify(binding.profile.label)} (${JSON.stringify(binding.profile.target)}), Linux root ${JSON.stringify(binding.root)}. Connection: ${binding.connected ? 'connected' : 'disconnected; reconnect in the SSH workspace UI'}.\nThe local Harness owns this session, models, credentials, skills, memory, and plugins. Existing local tools stay local. Use remote_exec and remote_files for project commands and files on this Linux host. Remote paths use POSIX syntax relative to the remote root. Local skill/reference paths remain local resources. To use a local script remotely, explicitly read its text locally and write that content to a remote file first; a local path is not executable remotely. Remote commands and file changes require the session’s Full access permission.`;
}

/** Controller owns bindings, inheritance and transport. read_binary returns {path,data:base64,mediaType,version?}. */
export function installRemoteTools(ctx, controller) {
  const records = new Map(), pending = new Map(), dead = new WeakSet(), stops = [];
  let closed = false;
  function remove(agent) {
    const record = records.get(agent.id);
    if (record?.agent === agent) { records.delete(agent.id); record.dispose(); }
  }
  async function refresh(agent) {
    if (closed || dead.has(agent)) return;
    const binding = await controller.bindingFor(agent.id);
    if (closed || dead.has(agent)) return;
    const previous = records.get(agent.id);
    if (!binding) { remove(agent); return; }
    if (previous?.agent === agent) { previous.binding = binding; return; }
    if (previous) remove(previous.agent);
    const record = { agent, binding, dispose: () => {} };
    let disposed = false;
    async function authorize(exec, mutate) {
      if (closed || disposed || exec.agent?.id !== agent.id) throw fail('REMOTE_UNBOUND', 'Remote tool does not belong to this agent');
      exec.signal?.throwIfAborted();
      const current = await controller.bindingFor(agent.id);
      if (!current) throw fail('REMOTE_UNBOUND', 'This session is no longer bound to an SSH workspace');
      record.binding = current;
      if (!current.connected) throw fail('REMOTE_DISCONNECTED', 'SSH workspace is disconnected; reconnect in the SSH workspace UI');
      if (mutate) {
        const session = ctx.sessions.get(agent.id);
        if (!session || ctx.sandboxPolicy.resolve({ session }).mode !== 'danger-full-access') throw fail('REMOTE_FULL_ACCESS_REQUIRED', FULL_ACCESS);
      }
      exec.signal?.throwIfAborted();
      if (closed || disposed) throw fail('REMOTE_UNBOUND', 'Remote tools have been disposed');
    }
    const definitions = [{
      name: 'remote_exec', description: 'Run non-interactive Bash on this session’s remote Linux host. Each call starts a fresh process; shell state does not persist. Returns exit code and bounded output.',
      parameters: { type: 'object', additionalProperties: false, required: ['command'], properties: { command: str('Bash command on the remote host.'), cwd: str('Remote POSIX directory; defaults to the bound root.'), timeout_ms: int('Remote command time limit in milliseconds, 1–600000; defaults to 60000. SSH startup and response delivery add a short allowance.') } },
      output, timeoutMs: 620000, isConcurrencySafe: () => false,
      presentCall: args => ({ card: 'terminal', title: 'Remote Bash', description: args.command, ...(args.cwd ? { cwd: args.cwd } : {}) }),
      async execute(args, exec) {
        const input = validate(args, true); input.timeout_ms ??= 60000;
        await authorize(exec, true);
        return controller.requestFor(agent.id, 'exec', input, { signal: exec.signal, timeoutMs: input.timeout_ms + 15000 });
      },
    }, {
      name: 'remote_files', description: 'Read, search, list, inspect images, or change remote Linux workspace files. Reads return a version for guarded changes. File changes require Full access.',
      parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
        action: { type: 'string', enum: ACTIONS, description: 'Operation to perform.' },
        path: str('Remote POSIX path; required for read/read_image/write/edit, otherwise defaults to root.'),
        pattern: str('Required glob pattern for glob or regular expression for grep.'), include: str('Optional file glob filter for grep.'),
        offset: int('First line for read, 1-based; defaults to 1.'), limit: int('Maximum lines/results, 1–2000; helper applies bounded defaults.'),
        content: str('Complete UTF-8 text for write; may be empty.'), old_string: str('Nonempty literal text to replace for edit.'), new_string: str('Replacement text for edit; may be empty.'),
        replace_all: { type: 'boolean', description: 'Replace all matches for edit; defaults to false.' },
        expected_version: str('Required for write/edit: version from a prior read; "missing" only creates a new file. Stale versions reject changes.'),
      } }, output,
      isConcurrencySafe: args => !!args && READ.has(args.action),
      presentCall: args => ({ card: 'generic', title: `Remote files: ${args.action}`, kind: READ.has(args.action) ? 'read' : 'edit' }),
      async execute(args, exec) {
        const input = validate(args);
        if (args.action === 'write' || args.action === 'edit') {
          input.expectedVersion = input.expected_version;
          delete input.expected_version;
        }
        if (args.action === 'edit') {
          input.old = input.old_string; input.new = input.new_string;
          delete input.old_string; delete input.new_string;
          if (input.replace_all !== undefined) { input.replaceAll = input.replace_all; delete input.replace_all; }
        }
        await authorize(exec, !READ.has(args.action));
        const result = await controller.requestFor(agent.id, args.action === 'read_image' ? 'read_binary' : args.action, input, { signal: exec.signal, timeoutMs: 60000 });
        if (args.action !== 'read_image') return result;
        exec.signal?.throwIfAborted();
        if (!result || typeof result.data !== 'string' || result.data.length > 24 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(result.mediaType)) throw fail('INVALID_IMAGE', 'Remote response is not a supported encoded image');
        const data = Buffer.from(result.data, 'base64');
        if (!data.length || data.toString('base64') !== result.data) throw fail('INVALID_IMAGE', 'Remote image encoding is empty or noncanonical');
        if (!ctx.attachments?.saveImage) throw fail('IMAGE_UNAVAILABLE', 'Local image attachment service is unavailable');
        const attachment = await ctx.attachments.saveImage({ data, mediaType: result.mediaType });
        return { path: typeof result.path === 'string' ? result.path : input.path, ...(typeof result.version === 'string' ? { version: result.version } : {}), attachment };
      },
    }];
    const effect = agent.ctx.effect(() => {
      const registered = [];
      try {
        for (const definition of definitions) registered.push(agent.ctx.tools.register(definition));
        registered.push(agent.ctx.systemPrompt.context({ name: 'ssh-gateway:remote-workspace', order: 355, required: true, interpolate: false, text: () => context(record.binding) }));
      } catch (error) { for (const stop of registered.reverse()) stop(); throw error; }
      return () => { disposed = true; for (const stop of registered.reverse()) stop(); };
    }, 'ssh-gateway remote tools');
    record.dispose = () => { if (!disposed) { disposed = true; effect(); } };
    records.set(agent.id, record);
  }
  function enqueue(agent) {
    const job = (pending.get(agent) ?? Promise.resolve()).catch(() => {}).then(() => refresh(agent));
    pending.set(agent, job);
    void job.finally(() => { if (pending.get(agent) === job) pending.delete(agent); }).catch(error => ctx.logger?.warn?.('SSH remote tools: %s', error.message));
    return job;
  }
  const dispose = () => {
    if (closed) return;
    closed = true;
    for (const stop of stops.reverse()) stop();
    for (const record of records.values()) record.dispose();
    records.clear();
  };
  try {
    stops.push(ctx.on('agent/created', ({ agent }) => enqueue(agent)));
    stops.push(ctx.on('agent/disposed', ({ agent }) => { dead.add(agent); remove(agent); }));
    // Children may inherit the changed Session's binding; refresh all live Agents.
    // Returning the aggregate lets binding APIs wait before accepting a first prompt.
    stops.push(controller.subscribeBindings(() => Promise.all(ctx.agents.list().map(agent => enqueue(agent)))));
    stops.push(ctx.effect(() => dispose, 'ssh-gateway remote tools owner'));
    for (const agent of ctx.agents.list()) void enqueue(agent).catch(() => {});
  } catch (error) { dispose(); throw error; }
  return dispose;
}
