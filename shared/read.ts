import type { FileDiffMetadata } from "@pierre/diffs";
import { hunkKey, type Chapter } from "./map";

// Read state is kept per branch (or PR) in read.json: hunk ids and ticked
// check items. A hunk id names the change, not its place in one diff, so a
// hunk read in a commit counts in the whole branch when the change is the same.

function changedLines(file: FileDiffMetadata, index: number) {
  const hunk = file.hunks[index];
  const removed: string[] = [];
  const added: string[] = [];
  for (const content of hunk.hunkContent) {
    if (content.type !== "change") continue;
    removed.push(...file.deletionLines.slice(content.deletionLineIndex, content.deletionLineIndex + content.deletions));
    added.push(...file.additionLines.slice(content.additionLineIndex, content.additionLineIndex + content.additions));
  }
  const clean = (line: string) => line.replace(/\r?\n$/, "");
  return { removed: removed.map(clean), added: added.map(clean) };
}

/** 53-bit string hash (cyrb53): ids stay short and collisions unlikely within one branch. */
function hash(text: string) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The id of hunk `index` of `file` (-1: a file without hunks, such as a binary or a pure rename). */
export function hunkId(file: FileDiffMetadata, index: number) {
  if (index < 0) return `${file.name}#${file.type}:${file.newObjectId ?? ""}`;
  const { removed, added } = changedLines(file, index);
  return `${file.name}#${hash([...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join("\n"))}`;
}

/** Ids of every hunk in `files`, keyed by `hunkKey` (the hunk's place in this diff). */
export function hunkIds(files: FileDiffMetadata[]) {
  const ids = new Map<string, string>();
  for (const file of files) {
    if (!file.hunks.length) ids.set(hunkKey(file.name, -1), hunkId(file, -1));
    file.hunks.forEach((_, index) => ids.set(hunkKey(file.name, index), hunkId(file, index)));
  }
  return ids;
}

/** The read-state key of check item `item` of a chapter. */
export const checkId = (chapter: Pick<Chapter, "title">, item: string) => `check:${chapter.title}\n${item}`;

/**
 * The chapter of each hunk of a commit (`commitFiles`) in the branch's map:
 * the chapter of the branch hunk that is the same change, or else of the
 * branch hunk in the same file sharing the most changed lines. Null when no
 * branch hunk shares any: the commit's change did not survive to the branch
 * head, or the map does not cover it.
 */
export function commitChapters(commitFiles: FileDiffMetadata[], branchFiles: FileDiffMetadata[], chapters: Chapter[]) {
  const chapterOf = new Map<string, number>();
  chapters.forEach((chapter, index) => { if (!chapter.uncovered) for (const key of chapter.hunks) chapterOf.set(key, index); });
  const branch = new Map(branchFiles.map((file) => [file.name, file]));
  const result: Array<{ id: string; chapter: number | null }> = [];
  for (const file of commitFiles) {
    const target = branch.get(file.name);
    const indices = file.hunks.length ? file.hunks.map((_, index) => index) : [-1];
    for (const index of indices) {
      const id = hunkId(file, index);
      let best: { chapter: number | null; score: number } = { chapter: null, score: 0 };
      if (target) {
        const lines = index < 0 ? null : changedLines(file, index);
        const targets = target.hunks.length ? target.hunks.map((_, hunk) => hunk) : [-1];
        for (const hunk of targets) {
          const chapter = chapterOf.get(hunkKey(target.name, hunk)) ?? null;
          if (hunkId(target, hunk) === id) { best = { chapter, score: Infinity }; break; }
          if (!lines || hunk < 0) continue;
          const other = changedLines(target, hunk);
          const added = new Set(other.added.map((line) => line.trim()).filter(Boolean));
          const removed = new Set(other.removed.map((line) => line.trim()).filter(Boolean));
          const score = lines.added.filter((line) => added.has(line.trim())).length + lines.removed.filter((line) => removed.has(line.trim())).length;
          if (score > best.score) best = { chapter, score };
        }
      }
      result.push({ id, chapter: best.chapter });
    }
  }
  return result;
}
