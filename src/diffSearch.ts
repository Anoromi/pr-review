import type { FileDiffMetadata } from "@pierre/diffs";
import type { DiffCursor } from "./diffCursor";

export function searchDiffs(files: FileDiffMetadata[], query: string): DiffCursor[] {
  if (!query) return [];
  const matches: DiffCursor[] = [];
  for (const file of files) {
    for (const side of ["deletions", "additions"] as const) {
      const prefix = side === "additions" ? "addition" : "deletion";
      const seen = new Set<number>();
      for (const hunk of file.hunks) {
        for (let offset = 0; offset < hunk[`${prefix}Count`]; offset++) {
          const line = hunk[`${prefix}Start`] + offset;
          if (seen.has(line)) continue;
          seen.add(line);
          const text = file[`${prefix}Lines`][file.isPartial ? hunk[`${prefix}LineIndex`] + offset : line - 1] ?? "";
          for (let column = text.indexOf(query); column !== -1; column = text.indexOf(query, column + query.length))
            matches.push({ id: file.name, side, line, column });
        }
      }
    }
  }
  return matches;
}

export function paintSearch(root: ShadowRoot, query: string) {
  root.querySelectorAll("[data-search-match]").forEach((node) => node.remove());
  if (!query) return;
  for (const line of root.querySelectorAll<HTMLElement>("[data-line]")) {
    const text = line.textContent ?? "";
    const bounds = line.getBoundingClientRect();
    if (!bounds.height) continue;
    for (let start = text.indexOf(query); start !== -1; start = text.indexOf(query, start + query.length)) {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      let offset = 0;
      let started = false;
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const size = node.textContent?.length ?? 0;
        if (!started && start < offset + size) { range.setStart(node, start - offset); started = true; }
        if (started && start + query.length <= offset + size) { range.setEnd(node, start + query.length - offset); break; }
        offset += size;
      }
      if (!node) continue;
      for (const rect of range.getClientRects()) {
        const mark = document.createElement("span");
        mark.dataset.searchMatch = "";
        mark.style.cssText = `position:absolute;pointer-events:none;background:#d6a51a;opacity:.35;left:${rect.left - bounds.left}px;top:${rect.top - bounds.top}px;width:${rect.width}px;height:${rect.height}px`;
        line.append(mark);
      }
    }
  }
}
