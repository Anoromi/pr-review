import { orderedPositions } from "./vimText";

export type DiffCursor = {
  id: string;
  line: number;
  side: "additions" | "deletions";
  column: number;
};

export function lineSide(node: HTMLElement): DiffCursor["side"] {
  return node.closest("[data-deletions]") ||
    node.dataset.lineType === "change-deletion"
    ? "deletions"
    : "additions";
}

export function columnAtPoint(line: HTMLElement, x: number, y: number) {
  const root = line.getRootNode();
  const doc = document as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
      options: { shadowRoots: ShadowRoot[] },
    ) => { offsetNode: Node; offset: number } | null;
  };
  const point = doc.caretPositionFromPoint?.(x, y, {
    shadowRoots: root instanceof ShadowRoot ? [root] : [],
  });
  if (!point || !line.contains(point.offsetNode)) return 0;
  const range = document.createRange();
  range.selectNodeContents(line);
  range.setEnd(point.offsetNode, point.offset);
  return range.toString().length;
}

export function paintCursor(
  root: ShadowRoot,
  id: string,
  cursor: DiffCursor | null,
  anchor: DiffCursor | null = null,
) {
  root
    .querySelectorAll("[data-vim-cursor]")
    .forEach((node) => node.removeAttribute("data-vim-cursor"));
  root.querySelectorAll("[data-vim-selection]").forEach((node) => node.remove());
  if (!cursor || cursor.id !== id) return;
  if (anchor && anchor.id === id && anchor.side === cursor.side) {
    const [start, end] = orderedPositions(anchor, cursor);
    for (const row of root.querySelectorAll<HTMLElement>("[data-line]")) {
      const number = Number(row.dataset.line);
      if (lineSide(row) !== cursor.side || number < start.line || number > end.line) continue;
      const length = (row.textContent ?? "").replace(/\n$/, "").length;
      const from = number === start.line ? Math.min(start.column, Math.max(0, length - 1)) : 0;
      const to = number === end.line ? Math.min(end.column + 1, length) : length;
      if (to <= from) continue;
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      let offset = 0;
      let started = false;
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const size = node.textContent?.length ?? 0;
        if (!started && from < offset + size) {
          range.setStart(node, from - offset);
          started = true;
        }
        if (started && to <= offset + size) {
          range.setEnd(node, to - offset);
          break;
        }
        offset += size;
      }
      if (!started || !node) continue;
      const bounds = row.getBoundingClientRect();
      for (const rect of range.getClientRects()) {
        const highlight = document.createElement("span");
        highlight.dataset.vimSelection = "";
        highlight.style.cssText = `left:${rect.left - bounds.left}px;top:${rect.top - bounds.top}px;width:${rect.width}px;height:${rect.height}px`;
        row.append(highlight);
      }
    }
  }
  const line = [
    ...root.querySelectorAll<HTMLElement>(`[data-line="${cursor.line}"]`),
  ].find((node) => lineSide(node) === cursor.side);
  if (!line) return;
  const length = (line.textContent ?? "").replace(/\n$/, "").length;
  let remaining = Math.max(0, Math.min(cursor.column, Math.max(0, length - 1)));
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let text: Node | null;
  let rect: DOMRect | undefined;
  while ((text = walker.nextNode())) {
    const size = text.textContent?.length ?? 0;
    if (remaining < size) {
      const range = document.createRange();
      range.setStart(text, remaining);
      range.setEnd(text, Math.min(remaining + 1, size));
      rect = range.getBoundingClientRect();
      break;
    }
    remaining -= size;
  }
  const bounds = line.getBoundingClientRect();
  line.style.setProperty(
    "--vim-x",
    `${rect && rect.height ? rect.left - bounds.left : 0}px`,
  );
  line.style.setProperty(
    "--vim-y",
    `${rect && rect.height ? Math.max(0, rect.top - bounds.top - 2) : 0}px`,
  );
  line.style.setProperty("--vim-width", `${rect?.width || 7.2}px`);
  line.setAttribute("data-vim-cursor", "");
}
