import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('built client registers and releases dictionaries across disable and re-enable', async () => {
  let module;
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(value) { module = value; } } }
  });
  assert.equal(module.id, 'dsh-ssh-gateway');
  const plugin = module.factory(name => {
    assert.equal(name, 'react');
    // This verifies plugin resource ownership; no component is rendered.
    return { createElement() { throw new Error('Unexpected rendering in registration test'); } };
  });
  const dictionaries = new Map();
  function mount() {
    const effects = [], slots = [];
    const ctx = {
      effect(fn) { effects.push(fn()); },
      locale: {
        register(namespace, language, entries) {
          const key = `${namespace}:${language}`;
          if (dictionaries.has(key)) throw new Error('Duplicate locale registration');
          dictionaries.set(key, entries);
          return () => { dictionaries.delete(key); };
        },
        bind() { return key => key; }
      },
      layout: {},
      slots: { inject(name, fn) { fn(); }, register(options, view) { slots.push(options); return () => {}; } }
    };
    plugin.apply(ctx);
    return { slots, unmount() { for (const dispose of effects.reverse()) dispose(); } };
  }
  const first = mount();
  assert.equal(dictionaries.size, 2);
  assert.equal(first.slots.some(slot => slot.name === 'main' && slot.key === 'ssh-gateway'), true);
  assert.equal([...dictionaries.values()].every(dict => typeof dict.intro === 'string' && typeof dict.sessionHelp === 'string'), true);
  assert.equal(first.slots.some(slot => slot.name === 'conversation.composer.dock' && slot.id === 'ssh-workspace-status'), true);
  first.unmount();
  assert.equal(dictionaries.size, 0);
  const second = mount();
  assert.equal(second.slots.some(slot => slot.name === 'settings.section' && slot.id === 'ssh-gateway'), true);
  second.unmount();
  assert.equal(dictionaries.size, 0);
});
