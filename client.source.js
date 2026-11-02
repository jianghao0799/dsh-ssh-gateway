window.__ModuleLoader__.load({
  id: 'dsh-ssh-gateway',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const dictionaries = {
      zh: { title: 'SSH 执行工作区', intro: 'Harness、会话、模型、技能、记忆和插件均由本机提供，只有项目文件与 Bash 命令通过 SSH 在远程 Linux 执行。远端不需要 DSH 或模型 Key。', label: '工作区名称', target: 'SSH 别名或 user@host', remotePath: '远程项目绝对路径', sshPort: 'SSH 端口（留空沿用 SSH config）', identityFile: '私钥路径（留空沿用 SSH config）', python: '远端 Python 3 命令或绝对路径', save: '保存目标', connect: '连接并检查环境', disconnect: '断开', edit: '编辑', remove: '删除', fresh: '清空表单', refresh: '刷新', connected: '已连接', disconnected: '未连接', connecting: '连接中', error: '连接失败', newSession: '新建本地会话并打开', preset: '本机预设', defaultPreset: '沿用本机默认预设', localSession: '选择已有本机会话', chooseSession: '选择会话，或在下方输入会话 ID', sessionId: '本机会话 ID', bind: '绑定此会话并打开', unbind: '解除 SSH 绑定', open: '打开本地会话', workspacePath: '工作区目录（可直接输入共享目录绝对路径）', pathHelp: '粘贴完整路径，按回车浏览；点击新建会话即可使用此目录创建工作区。已有会话保持原来的工作区。', browse: '跳转 / 浏览目录', up: '上一级', empty: '尚无 SSH 目标', local: 'Harness 在本机', sessionHelp: '要保留某个 Bot 的身份、记忆及已有对话，请绑定它原来的本机会话。新建普通会话不会自动继承其他 Bot 的记忆。', executionHelp: '项目操作使用 remote_exec / remote_files；原有本机工具保持本机含义。远程命令及文件修改要求会话选择 Full access，因为此版本不提供远端 OS 沙箱。', anchorHelp: '原生工作区列表中的 SSH 工作区使用本机元数据目录作分组标识，不是远程文件镜像。请用这里的远程目录浏览或 remote_files 查看项目。', sshHelp: '使用系统 OpenSSH，支持现有 SSH config 和 ProxyJump。需预先确认主机指纹；仅支持非交互密钥或 ssh-agent。远端需要 Python 3 和 Bash。', bindings: '本地会话绑定', noBindings: '尚无会话绑定', onlyLocal: '本机模型 / 技能 / 记忆 / 插件', noFallback: 'SSH 断开；请重新连接，项目操作不要回退到本机。', selected: '选中的远程目标' },
      en: { title: 'SSH execution workspaces', intro: 'Harness, sessions, models, skills, memory and plugins stay on this desktop. Only project files and Bash commands run on remote Linux over SSH. No remote DSH or model key is needed.', label: 'Workspace name', target: 'SSH alias or user@host', remotePath: 'Absolute remote project path', sshPort: 'SSH port (blank uses SSH config)', identityFile: 'Private key path (blank uses SSH config)', python: 'Remote Python 3 command or absolute path', save: 'Save target', connect: 'Connect and inspect', disconnect: 'Disconnect', edit: 'Edit', remove: 'Delete', fresh: 'Clear form', refresh: 'Refresh', connected: 'Connected', disconnected: 'Disconnected', connecting: 'Connecting', error: 'Connection failed', newSession: 'Create and open local session', preset: 'Local preset', defaultPreset: 'Use local default preset', localSession: 'Choose an existing local session', chooseSession: 'Choose a session, or enter its ID below', sessionId: 'Local session ID', bind: 'Bind and open this session', unbind: 'Remove SSH binding', open: 'Open local session', workspacePath: 'Workspace directory (paste an absolute shared path)', pathHelp: 'Paste a full path and press Enter to browse. Create a new session to use this directory as a workspace. Existing sessions retain their workspace.', browse: 'Go / browse directory', up: 'Parent directory', empty: 'No saved SSH targets', local: 'Harness stays local', sessionHelp: 'To retain a Bot identity, memory and conversation, bind its existing local session. A new ordinary session does not inherit another Bot’s memory.', executionHelp: 'Use remote_exec / remote_files for project operations. Existing local tools keep their local meaning. Remote commands and file changes require the session’s Full access setting because this version provides no remote OS sandbox.', anchorHelp: 'SSH entries in the native workspace list use local metadata directories for grouping, not remote file mirrors. Use this panel or remote_files to browse project files.', sshHelp: 'Uses system OpenSSH with existing SSH config and ProxyJump. Confirm host keys first; use a noninteractive key or ssh-agent. Remote Python 3 and Bash are required.', bindings: 'Local session bindings', noBindings: 'No session bindings', onlyLocal: 'Local models / skills / memory / plugins', noFallback: 'SSH disconnected. Reconnect; do not fall back to local project execution.', selected: 'Selected remote target' }
    };
    const css = `.ssw-page{height:100%;overflow:auto;box-sizing:border-box;padding:24px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font:inherit}.ssw-page h2{font-size:21px;margin:0 0 12px}.ssw-page p{line-height:1.6;max-width:900px}.ssw-muted{color:var(--dsw-alias-label-secondary);font-size:13px}.ssw-note{padding:14px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);max-width:900px;margin:16px 0;line-height:1.6}.ssw-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;max-width:900px;margin:18px 0}.ssw-field{display:flex;flex-direction:column;gap:7px;font-size:13px}.ssw-input{padding:9px 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;min-width:0;box-sizing:border-box;width:100%}.ssw-btn{padding:8px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}.ssw-btn:hover{background:var(--dsw-alias-bg-layer-2)}.ssw-btn:disabled{opacity:.5;cursor:default}.ssw-btn:focus-visible,.ssw-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.ssw-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;max-width:900px;padding:13px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}.ssw-grow{flex:1;min-width:220px;overflow-wrap:anywhere}.ssw-good{color:var(--dsw-alias-state-success-primary)}.ssw-error{color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;overflow-wrap:anywhere}.ssw-badge{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:5px 8px;font-size:12px;color:var(--dsw-alias-label-secondary)}.ssw-badge button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;text-decoration:underline}`;
    let snapshot = { targets: [], bindings: [] }, epoch = 0;
    const listeners = new Set();
    const endpoint = path => new URL(`/ssh-workspaces/v3/${path}`, location.href);
    const fresh = () => ({ label: '', target: '', remotePath: '/', sshPort: '', identityFile: '', python: 'python3' });
    const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
    async function request(path, options) {
      const response = await fetch(endpoint(path), { cache: 'no-store', ...options });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || `SSH workspace HTTP ${response.status}`);
      return result.value;
    }
    async function api(action, input) {
      const started = action ? ++epoch : epoch;
      const value = await request('control', action ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, input }) } : undefined);
      if (!action && started !== epoch) return snapshot;
      if (action) epoch++;
      snapshot = { mode: value.mode, targets: value.targets, bindings: value.bindings, busy: value.busy };
      for (const fn of listeners) fn();
      return value;
    }
    function Icon({ size = 20 }) { return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true }, h('rect', { x: 2, y: 3, width: 20, height: 15, rx: 3 }), h('path', { d: 'm6 8 3 3-3 3m6 0h5M8 22h8m-4-4v4' })); }
    return {
      inject: ['slots', 'locale', 'layout', 'uiWorkspace'],
      apply(ctx) {
        for (const language of ['en', 'zh']) ctx.effect(() => ctx.locale.register('ssh-local-harness', language, dictionaries[language]));
        const t = ctx.locale.bind('ssh-local-harness');
        function useLocale() { React.useSyncExternalStore(fn => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot()); }
        function Panel() {
          useLocale();
          const state = React.useSyncExternalStore(subscribe, () => snapshot);
          const [draft, setDraft] = React.useState(fresh), [selectedId, setSelectedId] = React.useState('');
          const [sessionId, setSessionId] = React.useState(''), [preset, setPreset] = React.useState('');
          const [workspacePath, setWorkspacePath] = React.useState('');
          const [catalog, setCatalog] = React.useState({ sessions: [], presets: [] });
          const [busy, setBusy] = React.useState(false), [error, setError] = React.useState(''), [listing, setListing] = React.useState(null);
          const selected = state.targets.find(target => target.id === selectedId) || state.targets[0];
          const ready = selected?.connection.status === 'ready';
          React.useEffect(() => { setWorkspacePath(selected?.connection.root || selected?.remotePath || ''); setListing(null); }, [selected?.id]);
          React.useEffect(() => {
            let alive = true, pending = false;
            const refresh = async () => { if (pending || document.hidden) return; pending = true; try { await api(); } catch (e) { if (alive) setError(e.message); } finally { pending = false; } };
            refresh();
            request('catalog').then(value => { if (alive) setCatalog(value); }).catch(e => { if (alive) setError(e.message); });
            const timer = setInterval(refresh, 5000);
            return () => { alive = false; clearInterval(timer); };
          }, []);
          const run = async (action, input) => {
            setBusy(true); setError('');
            try {
              const value = await api(action, input);
              if (action === 'save') setDraft(fresh());
              if (value.listing) { setListing({ ...value.listing, targetId: input.id }); setWorkspacePath(value.listing.path); }
              if (value.sessionId) ctx.uiWorkspace.openSession(value.sessionId);
            } catch (e) { setError(e.message); } finally { setBusy(false); }
          };
          const createAtPath = async (bindExisting = false) => {
            setBusy(true); setError('');
            try {
              const path = workspacePath.trim();
              if (!path.startsWith('/') || /[\x00-\x1f\x7f]/.test(path)) throw new Error('请输入远程 Linux 的绝对目录路径 / Enter an absolute remote Linux directory');
              let target = state.targets.find(item => (item.remotePath === path || item.connection.root === path) && ['target', 'sshPort', 'identityFile', 'python'].every(key => item[key] === selected[key]));
              if (!target) {
                const id = crypto.randomUUID();
                const label = (selected.label + ' · ' + (path.split('/').filter(Boolean).pop() || '/')).slice(0, 200);
                const value = await api('save', { ...selected, id, label, remotePath: path });
                target = value.targets.find(item => item.id === id);
              }
              if (target.connection.status !== 'ready') await api('connect', { id: target.id });
              const value = await api(bindExisting ? 'bind_session' : 'create_session', { id: target.id, ...(bindExisting ? { sessionId } : { agentPreset: preset || undefined }) });
              setSelectedId(target.id);
              ctx.uiWorkspace.openSession(value.sessionId);
            } catch (e) { setError(e.message); } finally { setBusy(false); }
          };
          const button = (label, onClick, disabled = busy) => h('button', { className: 'ssw-btn', type: 'button', disabled, onClick }, label);
          const field = key => h('label', { key, className: 'ssw-field' }, t(key), h('input', { className: 'ssw-input', type: key === 'sshPort' ? 'number' : 'text', min: key === 'sshPort' ? 1 : undefined, max: key === 'sshPort' ? 65535 : undefined, autoComplete: 'off', value: draft[key] ?? '', onChange: e => setDraft({ ...draft, [key]: key === 'sshPort' && e.target.value !== '' ? Number(e.target.value) : e.target.value }) }));
          return h('section', { className: 'ssw-page', 'data-dsh-plugin': 'ssh-gateway' }, h('style', null, css), h('h2', null, t('title')), h('p', { className: 'ssw-muted' }, t('intro')),
            error ? h('p', { className: 'ssw-error', role: 'alert' }, error) : null,
            h('div', { className: 'ssw-note ssw-muted' }, t('sshHelp')),
            state.targets.length ? state.targets.map(target => h('div', { className: 'ssw-row', key: target.id }, h('div', { className: 'ssw-grow' }, h('strong', null, target.label), h('div', { className: 'ssw-muted' }, `${target.target} : ${target.connection.root || target.remotePath}`), h('span', { className: target.connection.status === 'ready' ? 'ssw-good' : 'ssw-muted' }, t(({ ready: 'connected', disconnected: 'disconnected', connecting: 'connecting', error: 'error' })[target.connection.status] || 'disconnected')), target.connection.error ? h('div', { className: 'ssw-error' }, target.connection.error) : null), button(t('connect'), () => { setSelectedId(target.id); setListing(null); run('connect', { id: target.id }); }), button(t('disconnect'), () => run('disconnect', { id: target.id }), busy || target.connection.status !== 'ready'), button(t('edit'), () => setDraft(target)), button(t('remove'), () => run('delete', { id: target.id })))) : h('p', { className: 'ssw-muted' }, t('empty')),
            h('form', { onSubmit: e => { e.preventDefault(); run('save', draft); } }, h('div', { className: 'ssw-grid' }, ['label', 'target', 'remotePath', 'sshPort', 'identityFile', 'python'].map(field)), h('div', { className: 'ssw-row' }, h('button', { className: 'ssw-btn', type: 'submit', disabled: busy }, t('save')), button(t('fresh'), () => setDraft(fresh())))),
            selected ? h('div', { className: 'ssw-note' }, h('label', { className: 'ssw-field' }, t('selected'), h('select', { className: 'ssw-input', value: selected.id, disabled: busy, onChange: e => { setSelectedId(e.target.value); setListing(null); } }, state.targets.map(target => h('option', { value: target.id, key: target.id }, `${target.label} · ${target.remotePath}`)))), h('form', { onSubmit: e => { e.preventDefault(); run('browse', { id: selected.id, path: workspacePath.trim() }); } }, h('div', { className: 'ssw-row' }, h('label', { className: 'ssw-field ssw-grow' }, t('workspacePath'), h('input', { className: 'ssw-input', value: workspacePath, placeholder: '/shared/group/project', autoComplete: 'off', spellCheck: false, required: true, onChange: e => setWorkspacePath(e.target.value) })), h('button', { className: 'ssw-btn', type: 'submit', disabled: busy || !ready || !workspacePath.trim() }, t('browse')))), h('p', { className: 'ssw-muted' }, t('pathHelp')), h('div', { className: 'ssw-grid' }, h('label', { className: 'ssw-field' }, t('preset'), h('select', { className: 'ssw-input', value: preset, onChange: e => setPreset(e.target.value) }, h('option', { value: '' }, t('defaultPreset')), catalog.presets.map(item => h('option', { value: item.id, key: item.id, disabled: item.broken }, item.name || item.id)))), h('div', { style: { alignSelf: 'end' } }, button(t('newSession'), () => createAtPath(), busy || !workspacePath.trim()))),
              h('p', { className: 'ssw-muted' }, t('sessionHelp')), h('div', { className: 'ssw-grid' }, h('label', { className: 'ssw-field' }, t('localSession'), h('select', { className: 'ssw-input', value: catalog.sessions.some(s => s.sessionId === sessionId) ? sessionId : '', onChange: e => setSessionId(e.target.value) }, h('option', { value: '' }, t('chooseSession')), catalog.sessions.map(item => h('option', { value: item.sessionId, key: item.sessionId, disabled: item.running }, `${item.sessionId} · ${item.cwd || ''}`)))), h('label', { className: 'ssw-field' }, t('sessionId'), h('input', { className: 'ssw-input', value: sessionId, onChange: e => setSessionId(e.target.value) }))), h('div', { className: 'ssw-row' }, button(t('bind'), () => createAtPath(true), busy || !workspacePath.trim() || !sessionId), button(t('browse'), () => run('browse', { id: selected.id, path: workspacePath.trim() }), busy || !ready || !workspacePath.trim()))) : null,
            listing && selected?.id === listing.targetId ? h('div', { className: 'ssw-note' }, h('div', { className: 'ssw-row' }, h('code', { className: 'ssw-grow' }, listing.path), button(t('up'), () => run('browse', { id: selected.id, path: listing.path.replace(/\/[^/]+\/?$/, '') || '/' }))), listing.entries.map(entry => h('div', { className: 'ssw-row', key: entry.path }, entry.type === 'directory' ? button(entry.name + '/', () => run('browse', { id: selected.id, path: entry.path })) : h('span', { className: 'ssw-muted' }, entry.name)))) : null,
            h('h3', null, t('bindings')), state.bindings.length ? state.bindings.map(binding => h('div', { className: 'ssw-row', key: binding.sessionId }, h('div', { className: 'ssw-grow' }, h('code', null, binding.sessionId), h('div', { className: 'ssw-muted' }, `${state.targets.find(target => target.id === binding.targetId)?.label || binding.targetId} : ${binding.root}`)), button(t('open'), () => ctx.uiWorkspace.openSession(binding.sessionId)), button(t('unbind'), () => run('unbind_session', { sessionId: binding.sessionId })))) : h('p', { className: 'ssw-muted' }, t('noBindings')),
            h('p', { className: 'ssw-note ssw-muted' }, t('executionHelp')), h('p', { className: 'ssw-muted' }, t('anchorHelp')));
        }
        function Badge({ sessionId }) {
          useLocale();
          const [binding, setBinding] = React.useState(null);
          React.useEffect(() => {
            let alive = true, pending = false;
            const refresh = async () => { if (pending || document.hidden) return; pending = true; try { const value = await request(`control?sessionId=${encodeURIComponent(sessionId)}`); if (alive) setBinding(value.binding); } catch { if (alive) setBinding(null); } finally { pending = false; } };
            refresh(); const timer = setInterval(refresh, 3000);
            return () => { alive = false; clearInterval(timer); };
          }, [sessionId]);
          if (!binding) return null;
          return h('div', { className: 'ssw-badge', 'data-dsh-plugin': 'ssh-gateway' }, h('style', null, css), h(Icon, { size: 14 }), h('span', { className: binding.connected ? 'ssw-good' : 'ssw-error' }, `SSH · ${binding.profile.label} · ${binding.root}`), h('span', null, binding.connected ? t('onlyLocal') : t('noFallback')), h('button', { type: 'button', onClick: () => ctx.layout.selectPanel('ssh-gateway') }, t('title')));
        }
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'ssh-gateway', order: 25, label: () => t('title') }, Icon));
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'ssh-gateway' }, Panel));
        ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'ssh-gateway', order: 25, label: () => t('title') }, Panel));
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'ssh-workspace-status', order: 20 }, Badge));
      }
    };
  }
});
