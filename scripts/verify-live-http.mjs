import { authenticate } from './plugin-rpc.mjs';
import { createHash } from 'node:crypto';

const cookie = await authenticate();
const origin = new URL(process.env.DSH_RPC_URL || 'http://127.0.0.1:3258').origin;

async function get(path) {
  const response = await fetch(new URL(path, origin), {
    headers: { cookie },
    signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, text: await response.text() };
}

function requireCondition(value, message) {
  if (!value) throw new Error(message);
}

const control = await get('/ssh-workspaces/v3/control');
requireCondition(control.status === 200, `control route returned HTTP ${control.status}`);
const state = JSON.parse(control.text);
requireCondition(state.ok === true, 'control route returned a failed envelope');
const targets = state.value?.targets || [];
console.log(JSON.stringify({
  route: 'control',
  status: control.status,
  ok: true,
  busy: Boolean(state.value?.busy),
  bindingCount: state.value?.bindings?.length || 0,
  targetCount: targets.length,
  connectedTargetCount: targets.filter((target) => target.connection?.status === 'connected').length,
}));

const page = await get('/');
requireCondition(page.status === 200, `Web entry returned HTTP ${page.status}`);
const marker = 'globalThis["__DSH_BOOT__"] = ';
const bootStart = page.text.indexOf(marker);
requireCondition(bootStart >= 0, 'Web entry did not advertise __DSH_BOOT__');
const bootEnd = page.text.indexOf('</script>', bootStart);
requireCondition(bootEnd > bootStart, 'Web entry contained a malformed __DSH_BOOT__ script');
const serialized = page.text.slice(bootStart + marker.length, bootEnd).trim().replace(/;$/, '');
const boot = JSON.parse(serialized);
const entries = boot.entries || [];

const gateway = entries.find((entry) => entry.id === 'dsh-ssh-gateway')
  || entries.find((entry) => /ssh|harness-remote/i.test(`${entry.id} ${entry.url}`));
requireCondition(gateway, 'SSH gateway client entry is absent from __DSH_BOOT__');

const sidebar = entries.find((entry) => entry.id === 'dsh-better-sidebar');
const advertised = [gateway, sidebar].filter(Boolean);
const seenUrls = new Set();
for (const entry of advertised) {
  requireCondition(typeof entry.url === 'string' && entry.url.length > 0, `${entry.id} has no client URL`);
  if (seenUrls.has(entry.url)) continue;
  seenUrls.add(entry.url);
  const bundle = await get('/' + entry.url.replace(/^\//, ''));
  requireCondition(bundle.status === 200, `${entry.id} client bundle returned HTTP ${bundle.status}`);
  requireCondition(bundle.text.length > 0, `${entry.id} client bundle was empty`);
  console.log(JSON.stringify({
    entry: entry.id,
    status: bundle.status,
    bytes: bundle.text.length,
    sha256: createHash('sha256').update(bundle.text).digest('hex'),
  }));
}

console.log(JSON.stringify({
  release: boot.release,
  gatewayEntry: gateway.id,
  sidebarEntry: sidebar?.id || null,
  ok: true,
}));
