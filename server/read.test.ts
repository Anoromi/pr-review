import test from "node:test";
import assert from "node:assert/strict";
import { parseFiles } from "../shared/diff";
import { resolveMap, reviewMapSchema } from "../shared/map";
import { commitChapters, hunkId, hunkIds } from "../shared/read";

const branch = parseFiles([
  "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n",
  "@@ -1,3 +1,3 @@\n x\n-old\n+new\n y\n",
  "@@ -20,2 +20,4 @@\n p\n+first\n+second\n q\n",
  "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n",
  "@@ -5,1 +5,1 @@\n-b1\n+b2\n",
].join(""));

test("a hunk's id names its change, not its place: the same change in another diff has the same id", () => {
  // The same change at other line numbers, with other context, as a commit would show it.
  const moved = parseFiles("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -7,3 +7,3 @@\n other\n-old\n+new\n context\n");
  assert.equal(hunkId(moved[0], 0), hunkId(branch[0], 0));
  assert.notEqual(hunkId(branch[0], 0), hunkId(branch[0], 1));
  // The file is part of the id.
  const elsewhere = parseFiles("diff --git a/c.ts b/c.ts\n--- a/c.ts\n+++ b/c.ts\n@@ -1,3 +1,3 @@\n x\n-old\n+new\n y\n");
  assert.notEqual(hunkId(elsewhere[0], 0), hunkId(branch[0], 0));
  assert.deepEqual([...hunkIds(branch).keys()], ["a.ts#0", "a.ts#1", "b.ts#0"]);
});

test("a commit's hunks take the chapter of the same change, else of the branch hunk sharing most lines, else none", () => {
  const chapters = resolveMap(reviewMapSchema.parse({ chapters: [
    { title: "One", why: "W", risk: "low", hunks: [{ file: "a.ts", newStart: 1 }] },
    { title: "Two", why: "W", risk: "low", hunks: [{ file: "a.ts", newStart: 20 }] },
  ] }), branch);
  const commit = parseFiles([
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n",
    "@@ -1,3 +1,3 @@\n x\n-old\n+new\n y\n",
    // Only part of chapter two's change: a later commit added "second".
    "@@ -20,2 +20,3 @@\n p\n+first\n q\n",
    "@@ -40,1 +41,1 @@\n-gone\n+reverted later\n",
    "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n",
    "@@ -5,1 +5,1 @@\n-b1\n+b2\n",
  ].join(""));
  // b.ts#0 is the same change, but in the map's uncovered chapter.
  assert.deepEqual(commitChapters(commit, branch, chapters).map((hunk) => hunk.chapter), [0, 1, null, null]);
  assert.equal(commitChapters(commit, branch, chapters)[0].id, hunkId(branch[0], 0));
});
