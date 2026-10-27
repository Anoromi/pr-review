import test from "node:test";
import assert from "node:assert/strict";
import { chapterPatch, resolveMap, reviewMapSchema } from "../shared/map";
import { parseFiles } from "../shared/diff";

const patch = [
  "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n",
  "@@ -1,4 +1,1 @@\n keep\n-function f() {\n-    return 1;\n-}\n",
  "@@ -20,2 +18,3 @@\n x\n+added\n y\n",
  "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n",
  "@@ -5,1 +5,4 @@\n z\n+function f() {\n+  return 1;\n+}\n",
  "diff --git a/c.ts b/c.ts\n--- a/c.ts\n+++ b/c.ts\n",
  "@@ -1,1 +1,1 @@\n-old\n+new\n",
].join("");
const files = parseFiles(patch);
const map = (chapters: unknown[]) => reviewMapSchema.parse({ chapters });
const chapter = (hunks: unknown[], extra = {}) => ({ title: "T", why: "W", risk: "low", hunks, ...extra });

test("every hunk lands in one chapter and leftovers in a final uncovered chapter", () => {
  const chapters = resolveMap(map([
    chapter([{ file: "a.ts", newStart: 18 }, { file: "gone.ts" }, { file: "a.ts", newStart: 99 }]),
    // Whole-file references take only what exact references left; a hunk is claimed once.
    chapter([{ file: "a.ts" }, { file: "a.ts", oldStart: 20 }]),
  ]), files);
  assert.deepEqual(chapters.map((chapter) => chapter.hunks), [["a.ts#1"], ["a.ts#0"], ["b.ts#0", "c.ts#0"]]);
  assert.deepEqual(chapters[0].missing, [{ file: "a.ts", newStart: 99 }, { file: "gone.ts" }]);
  assert.deepEqual(chapters[1].missing, [{ file: "a.ts", oldStart: 20 }]);
  assert.equal(chapters[2].uncovered, true);
  assert.equal(resolveMap(map([chapter([{ file: "a.ts" }, { file: "b.ts" }, { file: "c.ts" }])]), files).length, 1);
});

test("notes anchor to diff lines on their side; notes on lines the diff lacks are listed, not dropped", () => {
  const [resolved] = resolveMap(map([chapter([{ file: "a.ts" }], { notes: [
    { file: "a.ts", start: 19, why: "Range in the new file" },
    { file: "a.ts", side: "old", start: 2, end: 4, why: "Removed lines" },
    { file: "a.ts", start: 2, end: 30, why: "Runs past the hunk" },
    { file: "a.ts", side: "old", start: 30, why: "Not in the diff" },
    { file: "gone.ts", start: 1, why: "No such file" },
  ] })]), files);
  assert.deepEqual(resolved.notes, [
    { file: "a.ts", side: "additions", start: 19, end: 19, why: "Range in the new file" },
    { file: "a.ts", side: "deletions", start: 2, end: 4, why: "Removed lines" },
  ]);
  assert.deepEqual(resolved.badNotes.map((note) => note.why), ["Runs past the hunk", "Not in the diff", "No such file"]);
  // Maps written before notes still load.
  assert.deepEqual(resolveMap(map([chapter([{ file: "a.ts" }])]), files)[0].notes, []);
});

test("moved code is verified only when removed and added lines match ignoring whitespace", () => {
  const moved = { skipSafe: { reason: "moved" } };
  const [move, changed, rest] = resolveMap(map([
    chapter([{ file: "a.ts", oldStart: 1 }, { file: "b.ts" }], moved),
    chapter([{ file: "c.ts" }], moved),
    chapter([{ file: "a.ts" }], { skipSafe: { reason: "generated" } }),
  ]), files);
  assert.equal(move.verified, true);
  assert.equal(changed.verified, false);
  assert.equal(rest.verified, undefined);
  // An addition-only "move" has nothing removed.
  assert.equal(resolveMap(map([chapter([{ file: "a.ts", newStart: 18 }], moved), chapter([{ file: "a.ts" }, { file: "b.ts" }, { file: "c.ts" }])]), files)[0].verified, false);
});

test("a chapter's patch keeps only its hunks, with their line numbers", () => {
  const cut = parseFiles(chapterPatch(patch, files, new Set(["a.ts#1", "c.ts#0"])));
  assert.deepEqual(cut.map((file) => [file.name, file.hunks.map((hunk) => hunk.additionStart)]), [["a.ts", [18]], ["c.ts", [1]]]);
});
