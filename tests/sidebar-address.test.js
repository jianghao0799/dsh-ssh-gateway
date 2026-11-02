import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('distributed address resolver preserves remote absolute paths on Windows sessions', () => {
  const source = readFileSync(new URL('../sidebar-adapter/lib/client.js', import.meta.url), 'utf8');
  const paths = source.match(/function resolveSidebarPath\(cwd, path\) \{[\s\S]*?\n\t\t\}/)?.[0];
  const address = source.match(/function resolveAddressPath\(base, path\) \{[\s\S]*?\n\t\t\}/)?.[0];
  assert.ok(paths); assert.ok(address);
  const context = vm.createContext({});
  const absolute = source.match(/function isAbsolutePath\$1\(path\) \{[\s\S]*?\n\t\t\}/)?.[0];
  assert.ok(absolute);
  vm.runInContext(`${absolute}\n${paths}\n${address}`, context);
  for (const file of ['/shared/group/图.png', '/shared/report.pdf', '/shared/readme.md']) {
    assert.equal(context.resolveAddressPath('C:\\local\\anchor', file), file);
  }
  assert.equal(context.resolveAddressPath('C:\\local\\anchor', 'src/a.txt'), 'C:\\local\\anchor\\src\\a.txt');
});
