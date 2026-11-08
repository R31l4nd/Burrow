import { describe, expect, it } from 'vitest';
import { findCommands, usedNow, type Command } from './commands.js';

const c = (id: string, title: string): Command => ({ id, title, run: () => {} });
const list = [c('save', 'Save'), c('format', 'Format the file'), c('fold', 'Fold all'), c('git', 'Show Git')];

describe('the command palette', () => {
  it('finds a command by a few letters of its name', () => {
    expect(findCommands(list, 'form').map((x) => x.id)).toEqual(['format']);
    expect(findCommands(list, 'git')[0]!.id).toBe('git');
    expect(findCommands(list, 'zzz')).toEqual([]);
  });

  it('with nothing typed: all, the ones used last first', () => {
    expect(findCommands(list, '', ['fold', 'git']).map((x) => x.id)).toEqual(['fold', 'git', 'save', 'format']);
  });

  it('keeps a handful of the last used, newest first, each once', () => {
    expect(usedNow(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(usedNow(['1', '2', '3', '4', '5', '6', '7', '8'], '9')).toHaveLength(8);
  });
});
