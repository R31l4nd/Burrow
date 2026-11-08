import { getSearchQuery, search, type SearchQuery } from '@codemirror/search';
import type { Extension } from '@codemirror/state';
import type { EditorView, Panel, ViewUpdate } from '@codemirror/view';
import { mount, unmount } from 'svelte';
import EditorFind from '../../components/EditorFind.svelte';
import { matchCount, type MatchCount } from './searchcount.js';

/** What the find panel shows: the query and the count in words, kept up to date by the panel. */
export interface FindState {
  query: SearchQuery;
  count: string;
}

/** The find panel (Ctrl+F) as the app's own component; `say` words the count ("3 of 12"). */
export function findPanel(say: (c: MatchCount) => string): Extension {
  return search({
    createPanel(view: EditorView): Panel {
      const dom = document.createElement('div');
      dom.className = 'cm-search';
      const counted = () => {
        const c = matchCount(view.state);
        return c ? say(c) : '';
      };
      const find: FindState = $state({ query: getSearchQuery(view.state), count: counted() });
      const shown = mount(EditorFind, { target: dom, props: { view, find } });
      const field = dom.querySelector<HTMLInputElement>('input[name=search]');
      // The field CodeMirror focuses on Ctrl+F while the panel is open.
      field?.setAttribute('main-field', 'true');
      return {
        dom,
        // In the page now: the field focused and its text chosen, as CodeMirror's own panel does (the tour: not focused).
        mount() {
          field?.select();
        },
        update(u: ViewUpdate) {
          const q = getSearchQuery(u.state);
          if (q !== find.query) find.query = q;
          if (u.docChanged || u.selectionSet || q !== getSearchQuery(u.startState)) find.count = counted();
        },
        destroy() {
          void unmount(shown);
        },
      };
    },
  });
}
