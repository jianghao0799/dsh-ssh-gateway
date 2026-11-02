import { spawn as nativeSpawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const CONTROL = /[\x00-\x1f\x7f]/;
export function validateRemoteTarget(v) {
  if (!v || typeof v !== 'object') throw new Error('Invalid remote target');
  const { id, label, target, remotePath, sshPort, identityFile } = v;
  if (typeof id !== 'string' || !/^[\w.-]{1,100}$/.test(id)) throw new Error('Invalid target id');
  if (typeof label !== 'string' || !label.trim() || label.length > 200 || CONTROL.test(label)) throw new Error('Invalid target label');
  if (typeof target !== 'string' || !/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(target)) throw new Error('Invalid SSH target');
  if (typeof remotePath !== 'string' || !remotePath.startsWith('/') || remotePath.includes('\0')) throw new Error('Invalid remote path');
  const python = v.python ?? 'python3';
  if (typeof python !== 'string' || CONTROL.test(python) || !(python.startsWith('/') || /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(python))) throw new Error('Invalid Python executable');
  if (sshPort !== undefined && (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535)) throw new Error('Invalid SSH port');
  if (identityFile !== undefined && (typeof identityFile !== 'string' || !identityFile || CONTROL.test(identityFile))) throw new Error('Invalid identity file');
  return { id, label, target, remotePath, python, ...(sshPort === undefined ? {} : { sshPort }), ...(identityFile === undefined ? {} : { identityFile }) };
}
export const PYTHON_BOOTSTRAP = "import sys; n=int(sys.stdin.buffer.readline(32)); assert 0<n<=262144; source=sys.stdin.buffer.read(n); exec(compile(source,'<remote-helper>','exec'))";
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const error = (code, message) => Object.assign(new Error(message), { code });
export class RemoteExecutor {
  constructor(config, { spawn = nativeSpawn, helperPath = new URL('./remote-helper.py', import.meta.url), cleanupTimeoutMs = 2500 } = {}) {
    this.config = validateRemoteTarget(config); this.spawn = spawn; this.helperPath = helperPath; this.cleanupTimeoutMs = cleanupTimeoutMs; this.children = new Set(); this.closed = false;
  }
  probe({ signal } = {}) { return this.request('probe', {}, { signal }); }
  async request(action, input = {}, { signal, timeoutMs = 60000 } = {}) {
    if (this.closed) throw error('CLOSED', 'Remote executor is closed');
    if (signal?.aborted) throw error('ABORTED', 'Remote operation cancelled');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw error('INVALID_REQUEST', 'Invalid timeout');
    const source = await readFile(this.helperPath);
    if (source.length > 262144) throw error('INVALID_HELPER', 'Remote helper is too large');
    const payload = Buffer.from(JSON.stringify({ action, input, root: this.config.remotePath }) + '\n');
    if (payload.length > 8 * 1024 * 1024) throw error('TOO_LARGE', 'Remote request is too large');
    if (this.closed || signal?.aborted) throw error('ABORTED', 'Remote operation cancelled');
    const c = this.config;
    const args = ['-T', '-oBatchMode=yes', '-oStrictHostKeyChecking=yes', '-oForwardAgent=no', '-oConnectTimeout=10'];
    if (c.sshPort) args.push('-p', String(c.sshPort));
    if (c.identityFile) args.push('-i', c.identityFile);
    args.push(c.target, `${quote(c.python)} -u -c ${quote(PYTHON_BOOTSTRAP)}`);
    return await new Promise((resolve, reject) => {
      let child;
      try { child = this.spawn('ssh', args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
      catch { reject(error('SSH_FAILED', 'SSH process could not start')); return; }
      this.children.add(child);
      let chunks = [], bytes = 0, failure, killTimer, settled = false;
      const stop = (reason) => {
        if (failure) return;
        failure = reason; child.stdin.end();
        killTimer = setTimeout(() => child.kill('SIGKILL'), this.cleanupTimeoutMs); killTimer.unref?.();
      };
      const aborted = () => stop(error('ABORTED', 'Remote operation cancelled'));
      const timer = setTimeout(() => stop(error('TIMEOUT', 'Remote operation timed out; remote outcome may be unknown')), timeoutMs);
      const finish = (code) => {
        if (settled) return; settled = true;
        clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', aborted); this.children.delete(child);
        if (failure) { reject(failure); return; }
        if (code !== 0) { reject(error('SSH_FAILED', 'SSH connection or remote helper failed')); return; }
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (result.ok === true && Object.hasOwn(result, 'result')) resolve(result.result);
          else if (result.ok === false && typeof result.error?.code === 'string' && typeof result.error?.message === 'string') reject(error(result.error.code, result.error.message));
          else reject(error('PROTOCOL', 'Invalid remote helper response'));
        } catch { reject(error('PROTOCOL', 'Invalid remote helper response')); }
      };
      child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) stop(error('TOO_LARGE', 'Remote response is too large')); else chunks.push(chunk); });
      child.stderr.resume(); child.stdin.on('error', () => {});
      child.on('error', () => { failure ??= error('SSH_FAILED', 'SSH process could not start'); }); child.on('close', finish);
      signal?.addEventListener('abort', aborted, { once: true });
      child.stdin.write(Buffer.concat([Buffer.from(`${source.length}\n`), source, payload]));
      if (signal?.aborted) aborted();
    });
  }
  async dispose() {
    this.closed = true;
    await Promise.all([...this.children].map(child => new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), this.cleanupTimeoutMs);
      child.once('close', () => { clearTimeout(timer); resolve(); }); child.stdin.end();
    })));
  }
}
