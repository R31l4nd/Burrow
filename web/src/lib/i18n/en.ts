// English is the source language: every key is in en.json. Each translation
// is a flat JSON file of the same keys (nl.json), the format Weblate edits
// (CONTRIBUTING.md); nl.ts types it against this, so a missing key fails the
// type check.
import source from './en.json' with { type: 'json' };

export type MessageKey = keyof typeof source;
export const en: Record<MessageKey, string> = source;
