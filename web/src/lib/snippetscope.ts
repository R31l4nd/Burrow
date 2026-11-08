import type { Group, Snippet } from '@burrow/shared';

/**
 * The snippets for a host: everyone's, the host's own, and those of its
 * group and every group above it. The completion in the terminal took the
 * host's own group only, the picker all of them (AUDIT2 TERM-20).
 */
export function snippetsFor(all: Snippet[], host: { id: number; groupId: number | null } | null | undefined, groups: Pick<Group, 'id' | 'parentId'>[]): Snippet[] {
  const ids: number[] = [];
  for (let g = groups.find((x) => x.id === host?.groupId); g && !ids.includes(g.id); g = groups.find((x) => x.id === g!.parentId)) ids.push(g.id);
  return all.filter((s) => (!s.hostId && !s.groupId) || (!!host && s.hostId === host.id) || (s.groupId !== null && ids.includes(s.groupId)));
}
