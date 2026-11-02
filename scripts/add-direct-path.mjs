import { readFile, writeFile } from 'node:fs/promises';
const file = new URL('../client.source.js', import.meta.url);
let source = await readFile(file, 'utf8');
function replace(old, next) { if (!source.includes(old)) throw new Error('Missing edit anchor: ' + old); source = source.replace(old, next); }
replace("browse: '浏览远程目录',", "workspacePath: '工作区目录（可直接输入共享目录绝对路径）', pathHelp: '粘贴完整路径，按回车浏览；点击新建会话即可使用此目录创建工作区。已有会话保持原来的工作区。', browse: '跳转 / 浏览目录',");
replace("browse: 'Browse remote directory',", "workspacePath: 'Workspace directory (paste an absolute shared path)', pathHelp: 'Paste a full path and press Enter to browse. Create a new session to use this directory as a workspace. Existing sessions retain their workspace.', browse: 'Go / browse directory',");
replace("const [sessionId, setSessionId] = React.useState(''), [preset, setPreset] = React.useState('');", "const [sessionId, setSessionId] = React.useState(''), [preset, setPreset] = React.useState('');\n          const [workspacePath, setWorkspacePath] = React.useState('');");
replace("const ready = selected?.connection.status === 'ready';", "const ready = selected?.connection.status === 'ready';\n          React.useEffect(() => { setWorkspacePath(selected?.connection.root || selected?.remotePath || ''); setListing(null); }, [selected?.id]);");
replace("if (value.listing) setListing({ ...value.listing, targetId: input.id });", "if (value.listing) { setListing({ ...value.listing, targetId: input.id }); setWorkspacePath(value.listing.path); }");
replace("          const button = (label", `          const createAtPath = async () => {
            setBusy(true); setError('');
            try {
              const path = workspacePath.trim();
              if (!path.startsWith('/') || /[\\x00-\\x1f\\x7f]/.test(path)) throw new Error('请输入远程 Linux 的绝对目录路径 / Enter an absolute remote Linux directory');
              let target = state.targets.find(item => (item.remotePath === path || item.connection.root === path) && ['target', 'sshPort', 'identityFile', 'python'].every(key => item[key] === selected[key]));
              if (!target) {
                const id = crypto.randomUUID();
                const label = (selected.label + ' · ' + (path.split('/').filter(Boolean).pop() || '/')).slice(0, 200);
                const value = await api('save', { ...selected, id, label, remotePath: path });
                target = value.targets.find(item => item.id === id);
              }
              if (target.connection.status !== 'ready') await api('connect', { id: target.id });
              const value = await api('create_session', { id: target.id, agentPreset: preset || undefined });
              setSelectedId(target.id);
              ctx.uiWorkspace.openSession(value.sessionId);
            } catch (e) { setError(e.message); } finally { setBusy(false); }
          };
          const button = (label`);
replace("h('div', { className: 'ssw-grid' }, h('label', { className: 'ssw-field' }, t('preset')", "h('form', { onSubmit: e => { e.preventDefault(); run('browse', { id: selected.id, path: workspacePath.trim() }); } }, h('div', { className: 'ssw-row' }, h('label', { className: 'ssw-field ssw-grow' }, t('workspacePath'), h('input', { className: 'ssw-input', value: workspacePath, placeholder: '/shared/group/project', autoComplete: 'off', spellCheck: false, required: true, onChange: e => setWorkspacePath(e.target.value) })), h('button', { className: 'ssw-btn', type: 'submit', disabled: busy || !ready || !workspacePath.trim() }, t('browse')))), h('p', { className: 'ssw-muted' }, t('pathHelp')), h('div', { className: 'ssw-grid' }, h('label', { className: 'ssw-field' }, t('preset')");
replace("button(t('newSession'), () => run('create_session', { id: selected.id, agentPreset: preset || undefined }), busy || !ready)", "button(t('newSession'), createAtPath, busy || !workspacePath.trim())");
replace("button(t('browse'), () => run('browse', { id: selected.id }), busy || !ready)", "button(t('browse'), () => run('browse', { id: selected.id, path: workspacePath.trim() }), busy || !ready || !workspacePath.trim())");
await writeFile(file, source);
