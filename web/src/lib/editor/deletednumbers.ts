import { getChunks, getOriginalDoc } from '@codemirror/merge';
import { GutterMarker, lineNumberWidgetMarker, type EditorView } from '@codemirror/view';
import { deletedLines } from './diffinfo.js';

// A comparison in one column: the lines gone are shown above the lines that took their place, as a
// block without line numbers. Here they get the older file's numbers in the line-number gutter, each
// as high as its line, a long one wrapped too (asked 2026-11-17, after report a43cd5).

class DeletedNumbers extends GutterMarker {
  override elementClass = 'cm-deletedNumbersGutter';
  constructor(
    readonly pos: number,
    readonly first: number,
    readonly count: number,
  ) {
    super();
  }
  override eq(other: GutterMarker) {
    return other instanceof DeletedNumbers && other.pos === this.pos && other.first === this.first && other.count === this.count;
  }
  override toDOM(view: EditorView) {
    const dom = document.createElement('div');
    dom.className = 'cm-deletedNumbers';
    for (let i = 0; i < this.count; i++) dom.appendChild(document.createElement('div')).textContent = String(this.first + i);
    view.requestMeasure({
      read: () => {
        const chunk = [...view.contentDOM.querySelectorAll('.cm-deletedChunk')].find((c) => view.posAtDOM(c) === this.pos);
        return chunk ? [...chunk.querySelectorAll('.cm-deletedLine')].map((l) => l.getBoundingClientRect().height) : null;
      },
      write: (heights) => heights?.forEach((h, i) => dom.children[i] instanceof HTMLElement && (dom.children[i].style.height = `${h}px`)),
    });
    return dom;
  }
}

export const deletedNumbers = lineNumberWidgetMarker.of((view, _widget, block) => {
  const chunks = getChunks(view.state)?.chunks;
  const at = chunks ? deletedLines(chunks, getOriginalDoc(view.state), block.from) : null;
  return at ? new DeletedNumbers(block.from, at.first, at.count) : null;
});
