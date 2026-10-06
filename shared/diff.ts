import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import type { Comment } from "./types";

export function parseFiles(patch: string): FileDiffMetadata[] {
  return parsePatchFiles(patch, undefined, true).flatMap((part) => part.files);
}

export function selectedCode(
  file: FileDiffMetadata,
  side: Comment["side"],
  start: number,
  end: number,
): string {
  const prefix = side === "additions" ? "addition" : "deletion";
  if (!file.isPartial) {
    const all = file[`${prefix}Lines`];
    if (start < 1 || end < start || end > all.length)
      throw new Error("Select a valid range of lines.");
    return all
      .slice(start - 1, end)
      .map((line) => line.replace(/\r?\n$/, ""))
      .join("\n");
  }
  const lines: string[] = [];
  for (let line = start; line <= end; line++) {
    const hunk = file.hunks.find(
      (h) =>
        line >= h[`${prefix}Start`] &&
        line < h[`${prefix}Start`] + h[`${prefix}Count`],
    );
    if (!hunk)
      throw new Error(
        "Select a continuous range of visible lines on one side of the diff.",
      );
    lines.push(
      file[`${prefix}Lines`][
        hunk[`${prefix}LineIndex`] + line - hunk[`${prefix}Start`]
      ].replace(/\r?\n$/, ""),
    );
  }
  return lines.join("\n");
}

export function fileStats(file: FileDiffMetadata) {
  return file.hunks.reduce(
    (stats, hunk) => ({
      added: stats.added + hunk.additionLines,
      removed: stats.removed + hunk.deletionLines,
    }),
    { added: 0, removed: 0 },
  );
}
