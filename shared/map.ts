import { z } from "zod";
import type { FileDiffMetadata } from "@pierre/diffs";

/**
 * A review map: the branch's hunks grouped into chapters in reading order.
 * Agents write it to map.json beside comments.json (see the review-map skill).
 */
export const reviewMapSchema = z.object({
  chapters: z.array(z.object({
    title: z.string().trim().min(1),
    why: z.string().trim().min(1),
    risk: z.enum(["low", "medium", "high"]),
    check: z.array(z.string().trim().min(1)).default([]),
    // A hunk is named by its file and the start of its `@@ -oldStart +newStart @@`
    // header; a file without starts takes every hunk of it no other chapter names.
    hunks: z.array(z.object({
      file: z.string().min(1),
      oldStart: z.number().int().nonnegative().optional(),
      newStart: z.number().int().nonnegative().optional(),
    })).min(1),
    // Why a line or range was written this way, shown under its last line.
    // `side` is the new file (default) or the old one, for removed lines.
    notes: z.array(z.object({
      file: z.string().min(1),
      side: z.enum(["new", "old"]).default("new"),
      start: z.number().int().positive(),
      end: z.number().int().positive().optional(),
      why: z.string().trim().min(1),
    })).default([]),
    skipSafe: z.object({ reason: z.enum(["moved", "generated", "formatting", "rename"]) }).optional(),
    // In a map of a thread's changes: what the user asked and the change does not do.
    notDone: z.array(z.string().trim().min(1)).default([]),
  })),
});
export type ReviewMap = z.infer<typeof reviewMapSchema>;
export type HunkRef = ReviewMap["chapters"][number]["hunks"][number];
type NoteRef = ReviewMap["chapters"][number]["notes"][number];
/** A note on lines of the diff, in the reader's coordinates. */
export type Note = { file: string; side: "additions" | "deletions"; start: number; end: number; why: string };

export type Chapter = Omit<ReviewMap["chapters"][number], "hunks" | "notes"> & {
  /** Hunks of this chapter as `hunkKey`s, in diff order. */
  hunks: string[];
  /** Notes whose lines are all in the diff. */
  notes: Note[];
  /** Notes naming lines the diff does not show (another file, side or line). */
  badNotes: NoteRef[];
  /** References that name no hunk of this diff (or one an earlier chapter took). */
  missing: HunkRef[];
  /** Set for the chapter that collects hunks no chapter names. */
  uncovered?: true;
  /** For moved code: whether the removed lines are exactly the added ones. */
  verified?: boolean;
};

export const hunkKey = (file: string, index: number) => `${file}#${index}`;

/** Every hunk of the diff lands in exactly one chapter; leftovers go to a final "uncovered" one. */
export function resolveMap(map: ReviewMap, files: FileDiffMetadata[]): Chapter[] {
  const owner = new Map<string, number>();
  const missing = map.chapters.map((): HunkRef[] => []);
  // Exact references first, so a whole-file reference only takes the rest.
  map.chapters.forEach((chapter, index) => {
    for (const ref of chapter.hunks) {
      if (ref.oldStart === undefined && ref.newStart === undefined) continue;
      const file = files.find((file) => file.name === ref.file);
      const hunk = file?.hunks.findIndex((hunk) =>
        (ref.newStart === undefined || hunk.additionStart === ref.newStart) &&
        (ref.oldStart === undefined || hunk.deletionStart === ref.oldStart));
      const key = file && hunk !== undefined && hunk >= 0 ? hunkKey(file.name, hunk) : undefined;
      if (key && !owner.has(key)) owner.set(key, index);
      else missing[index].push(ref);
    }
  });
  map.chapters.forEach((chapter, index) => {
    for (const ref of chapter.hunks) {
      if (ref.oldStart !== undefined || ref.newStart !== undefined) continue;
      const file = files.find((file) => file.name === ref.file);
      if (!file) { missing[index].push(ref); continue; }
      // A file without hunks (binary, pure rename) is one hunk-less entry.
      const keys = file.hunks.length ? file.hunks.map((_, hunk) => hunkKey(file.name, hunk)) : [hunkKey(file.name, -1)];
      for (const key of keys) if (!owner.has(key)) owner.set(key, index);
    }
  });
  const chapters: Chapter[] = map.chapters.map((chapter, index) => {
    const notes = chapter.notes.map((ref) => ({ ref, note: { file: ref.file, side: ref.side === "old" ? "deletions" as const : "additions" as const, start: ref.start, end: Math.max(ref.start, ref.end ?? ref.start), why: ref.why } }));
    const shown = notes.filter(({ note }) => inDiff(files, note));
    return { ...chapter, hunks: [], notes: shown.map(({ note }) => note), badNotes: notes.filter((item) => !shown.includes(item)).map(({ ref }) => ref), missing: missing[index] };
  });
  const uncovered: Chapter = { title: "", why: "", risk: "high", check: [], notDone: [], hunks: [], notes: [], badNotes: [], missing: [], uncovered: true };
  for (const file of files) {
    const keys = file.hunks.length ? file.hunks.map((_, hunk) => hunkKey(file.name, hunk)) : [hunkKey(file.name, -1)];
    for (const key of keys) {
      const index = owner.get(key);
      (index === undefined ? uncovered : chapters[index]).hunks.push(key);
    }
  }
  for (const chapter of chapters)
    if (chapter.skipSafe?.reason === "moved") chapter.verified = isMove(files, chapter.hunks);
  return uncovered.hunks.length ? [...chapters, uncovered] : chapters;
}

/** Whether every line of `note` is a line of one hunk of its file, on its side. */
function inDiff(files: FileDiffMetadata[], note: Note) {
  const file = files.find((file) => file.name === note.file);
  const prefix = note.side === "additions" ? "addition" : "deletion";
  return Boolean(file?.hunks.some((hunk) =>
    note.start >= hunk[`${prefix}Start`] && note.end < hunk[`${prefix}Start`] + hunk[`${prefix}Count`]));
}

/**
 * Moved code: the lines the hunks remove are the lines they add, as a
 * multiset, ignoring whitespace and blank lines.
 */
function isMove(files: FileDiffMetadata[], keys: string[]) {
  const removed: string[] = [];
  const added: string[] = [];
  for (const key of keys) {
    const split = key.lastIndexOf("#");
    const file = files.find((file) => file.name === key.slice(0, split));
    const hunk = file?.hunks[Number(key.slice(split + 1))];
    if (!file || !hunk) continue;
    for (const content of hunk.hunkContent) {
      if (content.type !== "change") continue;
      removed.push(...file.deletionLines.slice(content.deletionLineIndex, content.deletionLineIndex + content.deletions));
      added.push(...file.additionLines.slice(content.additionLineIndex, content.additionLineIndex + content.additions));
    }
  }
  const normalize = (lines: string[]) => lines.map((line) => line.replace(/\s+/g, "")).filter(Boolean).sort();
  const [a, b] = [normalize(removed), normalize(added)];
  return a.length > 0 && a.length === b.length && a.every((line, index) => line === b[index]);
}

/** `patch` cut down to the hunks in `keys`; `files` is `patch` parsed. */
export function chapterPatch(patch: string, files: FileDiffMetadata[], keys: Set<string>) {
  const sections = patch.split(/^(?=diff --git )/m).filter((section) => section.startsWith("diff --git "));
  if (sections.length !== files.length) throw new Error("The patch and its parsed files disagree.");
  return sections.map((section, index) => {
    const name = files[index].name;
    if (keys.has(hunkKey(name, -1))) return section;
    // Hunk lines start with a space, + , - or \, so only headers start with @@.
    const [header, ...hunks] = section.split(/^(?=@@ )/m);
    const kept = hunks.filter((_, hunk) => keys.has(hunkKey(name, hunk)));
    return kept.length ? header + kept.join("") : "";
  }).join("");
}
