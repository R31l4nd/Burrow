// Favourite folders of the phone (report 9980fa), as a host's folders have
// theirs: kept in this app's own storage on the phone, never on Burrow's
// server, so the phone's folder names stay on the phone like its files.

export interface PhoneFavorite {
  /** "/<folder id>/<names>", as PhoneFiles names it. */
  path: string;
  /** The folder's own name. */
  name: string;
  /** The granted folder (or storage) it is in, to say where. */
  root: string;
}

const KEY = 'burrow.phoneFavorites';
/** At most this many: a list to pick from, not an index. */
const MAX = 50;

function read(): PhoneFavorite[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    if (!Array.isArray(list)) return [];
    return list.filter((f): f is PhoneFavorite => !!f && typeof f.path === 'string' && /^\/[0-9a-f]{16}(\/|$)/.test(f.path) && typeof f.name === 'string' && typeof f.root === 'string').slice(0, MAX);
  } catch {
    return [];
  }
}

export const phoneFavorites = $state({ list: read() });

function keep() {
  try {
    localStorage.setItem(KEY, JSON.stringify(phoneFavorites.list));
  } catch {
    // Not kept past this page: still shown until it closes.
  }
}

export const isPhoneFavorite = (path: string) => phoneFavorites.list.some((f) => f.path === path);

/** Added (true) or taken off again (false). */
export function togglePhoneFavorite(f: PhoneFavorite): boolean {
  if (isPhoneFavorite(f.path)) {
    phoneFavorites.list = phoneFavorites.list.filter((x) => x.path !== f.path);
    keep();
    return false;
  }
  phoneFavorites.list = [...phoneFavorites.list, f].slice(-MAX);
  keep();
  return true;
}
