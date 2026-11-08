import type { Changelog, OpInfo } from '@burrow/shared';
import { get, post } from './api.js';
import { nudgeActivity } from './activity.svelte.js';
import { ask } from './confirm.svelte.js';
import { breakingItems, unreadItems } from './breakingitems.js';
import { t } from './i18n/index.svelte.js';

// Updating some of a stack's services by hand, from the stack's page or a
// container's: first the release notes in between. A breaking change (or a
// new major version) is named, and the update waits for a yes.

/**
 * Whether to go on: yes when nothing in the notes asks to read them first,
 * else the person's answer. Notes that cannot be read are asked about once
 * per stack (`project`): after a yes, that stack's updates go on without the
 * question for them (decision 9: most small images have no notes, and the
 * question became a reflex). A breaking change is always asked.
 */
export async function readFirst(hostId: number, images: string[], project?: string | null): Promise<boolean> {
  const read = await Promise.all(
    [...new Set(images)].map((image) => get<Changelog>(`/api/docker/${hostId}/changelog?image=${encodeURIComponent(image)}`).then((c) => ({ image, c }), () => null)),
  );
  const unique = [...new Set(images)];
  const breaking = breakingItems(read.filter((x) => x !== null));
  const unread = unreadItems(unique.filter((_, i) => read[i] === null), t('updates.notesUnread'));
  if (!breaking.length && !unread.length) return true;
  const stack = project ? `/api/docker/${hostId}/stacks/${encodeURIComponent(project)}/notes` : null;
  if (!breaking.length && stack && (await get<{ waived: boolean }>(stack).catch(() => ({ waived: false }))).waived) return true;
  const yes = await ask({ text: t('updates.breakingAsk'), items: [...breaking, ...unread], confirm: t('updates.updateAnyway'), danger: true });
  if (yes && unread.length && stack) await post(`${stack}/waive`).catch(() => {});
  return yes;
}

/** These services of a stack pulled and recreated (the stack's "update" operation). */
export async function updateServices(hostId: number, project: string, services: string[]): Promise<OpInfo> {
  const op = await post<OpInfo>(`/api/docker/${hostId}/stacks/${encodeURIComponent(project)}/ops`, { op: 'update', services });
  nudgeActivity();
  return op;
}
