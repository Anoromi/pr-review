import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hydratePartialDiff } from "@pierre/diffs";
import { loadContext } from "./context";
import { parseFiles, selectedCode } from "../shared/diff";
import { ReviewStore } from "./store";
import { createRouter } from "./router";
import type { Review } from "../shared/types";

const oldText = Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`).join(
  "",
);
const newText = oldText.replace("line 11\n", "changed\n");
const blob = (text: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest("hex");
const fixture = (): Review => ({
  id: "b".repeat(24),
  title: "test",
  source: { kind: "github", url: "https://github.com/owner/repo/pull/1" },
  revision: "a".repeat(40),
  baseRevision: "b".repeat(40),
  patch: `diff --git a/example.ts b/example.ts\nindex ${blob(oldText).slice(0, 12)}..${blob(newText).slice(0, 12)} 100644\n--- a/example.ts\n+++ b/example.ts\n@@ -10,3 +10,3 @@\n line 10\n-line 11\n+changed\n line 12\n`,
  comments: [],
  viewed: [],
  updatedAt: new Date().toISOString(),
});

test("context uses the merge base, validates blobs, caches contents and saves comments on expanded lines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "review-context-"));
  try {
    const store = new ReviewStore(directory);
    const review = fixture();
    await store.save(review);
    const file = parseFiles(review.patch)[0];
    const requests: string[][] = [];
    const run = async (args: string[]) => {
      requests.push(args);
      if (args[1].includes("/compare/"))
        return JSON.stringify({ merge_base_commit: { sha: "c".repeat(40) } });
      return args[1].endsWith("c".repeat(40)) ? oldText : newText;
    };
    const context = await loadContext(store.path(review.id), review, file, run);
    assert.equal(requests.length, 3);
    assert.ok(
      requests.some((args) => args[1].endsWith("ref=" + "c".repeat(40))),
    );
    await loadContext(store.path(review.id), review, file, async () => {
      throw new Error("cache missed");
    });
    hydratePartialDiff("merge", file, context);
    assert.equal(selectedCode(file, "additions", 1, 2), "line 1\nline 2");
    assert.equal(selectedCode(file, "deletions", 11, 11), "line 11");
    assert.throws(() => selectedCode(file, "additions", 31, 31));
    const caller = createRouter(store).createCaller({});
    const saved = await caller.saveComment({
      id: review.id,
      file: file.name,
      side: "additions",
      start: 1,
      end: 2,
      body: "context comment",
    });
    assert.equal(saved.comments[0].code, "line 1\nline 2");
    assert.equal((await store.read(review.id)).comments.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("context rejects contents that do not match the patch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "review-context-"));
  try {
    const review = fixture();
    await assert.rejects(
      loadContext(
        directory,
        review,
        parseFiles(review.patch)[0],
        async (args) =>
          args[1].includes("/compare/")
            ? JSON.stringify({ merge_base_commit: { sha: "c".repeat(40) } })
            : "wrong revision",
      ),
      /do not match/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
