import { describe, expect, it } from 'vitest';
import { loadSpec, setSpecImporter } from './specs.js';

describe('completion specs', () => {
  it('one that failed to load, or an index that did, is asked for again, not kept as none (AUDIT2 TERM-11)', async () => {
    let indexUp = false;
    let specUp = false;
    setSpecImporter(
      async (name) => {
        if (!specUp) throw new Error('offline');
        return { default: { name } };
      },
      async () => {
        if (!indexUp) throw new Error('offline');
        return ['git'];
      },
    );
    expect(await loadSpec('git')).toBeNull();
    indexUp = true;
    expect(await loadSpec('git')).toBeNull();
    specUp = true;
    expect(await loadSpec('git')).toEqual({ name: 'git' });
    // Not in the index at all: none, and that is kept.
    expect(await loadSpec('nosuchtool')).toBeNull();
  });
});
