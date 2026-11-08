import { needsReading, type Changelog } from '@burrow/shared';

/**
 * What to read first, per image: its name without the registry, then each
 * warning once with the versions that give it (three release candidates
 * with the same text were three times the same paragraph, report 06354e).
 */
export function breakingItems(read: { image: string; c: Pick<Changelog, 'releases'> }[]): { title: string; lines: string[] }[] {
  return read.flatMap(({ image, c }) => {
    const byText = new Map<string, string[]>();
    for (const r of c.releases.filter((r) => needsReading(r.flags))) {
      const said = r.flags.breaking[0] ?? '';
      byText.set(said, [...(byText.get(said) ?? []), r.name]);
    }
    if (!byText.size) return [];
    // Without its registry (a first part with a dot or a port, or localhost), as Docker reads a name.
    const title = image.replace(/@sha256:[0-9a-f]+$/, '').replace(/^(?:[^/]*[.:][^/]*|localhost)\//, '');
    return [{ title, lines: [...byText].map(([said, versions]) => (said ? `${versions.join(', ')}: ${said}` : versions.join(', '))) }];
  });
}

/**
 * Images whose notes could not be read, as items of their own: not taken for
 * "nothing to read", which let the update go on unasked (AUDIT2 WEB-09).
 */
export function unreadItems(images: string[], unread: string): { title: string; lines: string[] }[] {
  return images.map((image) => ({ title: image.replace(/@sha256:[0-9a-f]+$/, '').replace(/^(?:[^/]*[.:][^/]*|localhost)\//, ''), lines: [unread] }));
}
