import { RemoteExecutor } from '../remote-executor.js';

const target = process.env.SSH_TARGET;
if (!target) throw new Error('Set SSH_TARGET to an SSH config alias or user@host');
const remotePath = process.env.SSH_REMOTE_PATH || '/';
const sshPort = process.env.SSH_PORT ? Number(process.env.SSH_PORT) : undefined;
const identityFile = process.env.SSH_IDENTITY_FILE || undefined;
const python = process.env.SSH_PYTHON || 'python3';
const executor = new RemoteExecutor({
  id: 'acceptance-probe',
  label: 'SSH acceptance probe',
  target,
  remotePath,
  python,
  ...(sshPort === undefined ? {} : { sshPort }),
  ...(identityFile === undefined ? {} : { identityFile }),
});

try {
  const probe = await executor.probe();
  const result = await executor.request('exec', {
    command: 'printf "HOME=%s\\n" "$HOME"; pwd; command -v python3; command -v bash',
    cwd: remotePath,
    timeout_ms: 10_000,
  }, { timeoutMs: 30_000 });
  console.log(JSON.stringify({ probe, environment: result }, null, 2));
} finally {
  await executor.dispose();
}
