import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewStore } from "./store";
import { createRouter } from "./router";
import { loadPullRequest, parsePullUrl, listMyPulls } from "./github";
import { markdown } from "./markdown";
import type { Review } from "../shared/types";

process.env.GITHUB_REPO = "acme/widgets";

const patch =
  'diff --git a/src/example.ts b/src/example.ts\nindex abc1234..def5678 100644\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -10,3 +10,4 @@\n const before = true;\n-const value = 1;\n+const value = 2;\n+const fence = "```";\n export { value };\n';
const fixture = (): Review => ({
  id: "a".repeat(24),
  title: "owner/repo #1: test",
  source: { kind: "github", url: "https://github.com/owner/repo/pull/1" },
  revision: "head",
  baseRevision: "base",
  patch,
  comments: [],
  viewed: [],
  updatedAt: new Date().toISOString(),
});

async function usingStore(run: (store: ReviewStore) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pr-review-test-"));
  try {
    const store = new ReviewStore(root);
    await store.save(fixture());
    await run(store);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("comments preserve old and new coordinates, persist, edit, delete, and update Markdown", () =>
  usingStore(async (store) => {
    const caller = createRouter(store).createCaller({});
    const id = fixture().id;
    const first = await caller.saveComment({
      id,
      file: "src/example.ts",
      side: "deletions",
      start: 11,
      end: 11,
      body: "Explain the old behavior.",
    });
    assert.equal(first.comments[0].code, "const value = 1;");
    const second = await caller.saveComment({
      id,
      file: "src/example.ts",
      side: "additions",
      start: 11,
      end: 12,
      body: "Handle the edge case.",
    });
    assert.equal(
      second.comments[1].code,
      'const value = 2;\nconst fence = "```";',
    );
    let md = await readFile(join(store.path(id), "review.md"), "utf8");
    assert.match(md, /Old lines 11/);
    assert.match(md, /New lines 11-12/);
    assert.match(md, /\n````\n/);
    await caller.saveComment({
      id,
      commentId: first.comments[0].id,
      file: "src/example.ts",
      side: "deletions",
      start: 11,
      end: 11,
      body: "Updated feedback.",
    });
    await caller.deleteComment({ id, commentId: second.comments[1].id });
    md = await readFile(join(store.path(id), "review.md"), "utf8");
    assert.match(md, /Updated feedback/);
    assert.doesNotMatch(md, /Handle the edge case/);
    assert.equal(
      (await new ReviewStore(store.root).read(id)).comments.length,
      1,
    );
  }));

test("simultaneous writes retain both comments and viewed state", () =>
  usingStore(async (store) => {
    const caller = createRouter(store).createCaller({});
    const id = fixture().id;
    await Promise.all([
      caller.saveComment({
        id,
        file: "src/example.ts",
        side: "additions",
        start: 11,
        end: 11,
        body: "First",
      }),
      caller.saveComment({
        id,
        file: "src/example.ts",
        side: "additions",
        start: 12,
        end: 12,
        body: "Second",
      }),
      caller.viewed({ id, file: "src/example.ts", viewed: true }),
    ]);
    const saved = await store.read(id);
    assert.equal(saved.comments.length, 2);
    assert.deepEqual(saved.viewed, ["src/example.ts"]);
    assert.equal((await store.list())[0].commentCount, 2);
  }));

test("rejects invisible coordinates, blank comments, unknown files, and invalid IDs", () =>
  usingStore(async (store) => {
    const caller = createRouter(store).createCaller({});
    const valid = {
      id: fixture().id,
      file: "src/example.ts",
      side: "additions" as const,
      start: 11,
      end: 11,
      body: "Review",
    };
    await assert.rejects(caller.saveComment({ ...valid, start: 1, end: 1 }));
    await assert.rejects(caller.saveComment({ ...valid, body: "  " }));
    await assert.rejects(caller.saveComment({ ...valid, file: "unknown.ts" }));
    await assert.rejects(caller.get({ id: "../secret" }));
    assert.equal((await store.read(valid.id)).comments.length, 0);
  }));

test("matching head and base reuse disk cache without downloading a diff", () =>
  usingStore(async (store) => {
    const calls: string[][] = [];
    const result = await loadPullRequest(
      fixture().source.url,
      (url, head, base) => store.findCached(url, head, base),
      async (args) => {
        calls.push(args);
        return JSON.stringify({
          title: "test",
          head: { sha: "head" },
          base: { sha: "base" },
          changed_files: 1,
        });
      },
    );
    assert.equal(result.id, fixture().id);
    assert.equal(calls.length, 1);
    assert.equal(
      await store.findCached(fixture().source.url, "other-head", "base"),
      undefined,
    );
    assert.equal(
      await store.findCached(fixture().source.url, "head", "other-base"),
      undefined,
    );
  }));

test("a new base downloads a new snapshot and retains the old review", () =>
  usingStore(async (store) => {
    const calls: string[][] = [];
    const result = await loadPullRequest(
      fixture().source.url,
      (url, head, base) => store.findCached(url, head, base),
      async (args) => {
        calls.push(args);
        return args.includes("-H")
          ? patch
          : JSON.stringify({
              title: "test",
              head: { sha: "head" },
              base: { sha: "new-base" },
              changed_files: 1,
            });
      },
    );
    assert.equal(calls.length, 3);
    assert.notEqual(result.id, fixture().id);
    await store.save(result);
    assert.equal((await store.list()).length, 2);
  }));

test("rejects a diff if the PR changes during download or files are missing", async () => {
  let metadataCalls = 0;
  await assert.rejects(
    loadPullRequest(fixture().source.url, undefined, async (args) =>
      args.includes("-H")
        ? patch
        : JSON.stringify({
            title: "test",
            head: { sha: String(metadataCalls++) },
            base: { sha: "base" },
            changed_files: 1,
          }),
    ),
    /changed while loading/,
  );
  await assert.rejects(
    loadPullRequest(fixture().source.url, undefined, async (args) =>
      args.includes("-H")
        ? patch
        : JSON.stringify({
            title: "test",
            head: { sha: "head" },
            base: { sha: "base" },
            changed_files: 2,
          }),
    ),
    /incomplete diff/,
  );
});

test("normalizes supported PR URLs and rejects arbitrary hosts or credentials", () => {
  assert.equal(
    parsePullUrl("https://diffshub.com/owner/repo/pull/123/files?x=y#diff").url,
    "https://github.com/owner/repo/pull/123",
  );
  for (const url of [
    "https://evil.example/a/b/pull/1",
    "https://github.com@evil.example/a/b/pull/1",
    "http://github.com/a/b/pull/1",
    "https://github.com/a/b/pull/0",
    "https://github.com/a/b/../../secret",
  ])
    assert.throws(() => parsePullUrl(url));
});

test("empty Markdown includes the review revision and source", () => {
  const output = markdown(fixture());
  assert.match(output, /Revision: head/);
  assert.match(output, /No comments yet/);
});

test("PR picker requests only the current user's open PRs and orders by latest update", async () => {
  let command: string[] = [];
  const result = await listMyPulls(async (args) => {
    command = args;
    return JSON.stringify([
      { number: 1, updatedAt: "2026-09-01T00:00:00Z" },
      { number: 2, updatedAt: "2026-09-08T00:00:00Z" },
    ]);
  });
  assert.equal(command[command.indexOf("--repo") + 1], "acme/widgets");
  assert.equal(command[command.indexOf("--author") + 1], "@me");
  assert.equal(command[command.indexOf("--state") + 1], "open");
  assert.deepEqual(
    result.map((pull) => pull.number),
    [2, 1],
  );
});

test("comments belong to the PR across snapshots, edits, deletions and restarts", () =>
  usingStore(async (store) => {
    const caller = createRouter(store).createCaller({});
    const original = await caller.saveComment({ id: fixture().id, file: "src/example.ts", side: "additions", start: 11, end: 11, body: "Keep this feedback." });
    const next = await store.save({ ...fixture(), id: "b".repeat(24), revision: "new-head", patch: "" });
    assert.equal(next.comments[0].id, original.comments[0].id);
    assert.equal(next.comments[0].snapshotId, original.id);
    assert.equal(next.comments[0].code, "const value = 2;");
    const other = await store.save({ ...fixture(), id: "c".repeat(24), source: { kind: "github", url: "https://github.com/owner/repo/pull/2" } });
    assert.equal(other.comments.length, 0);
    await caller.saveComment({ id: original.id, commentId: original.comments[0].id, file: "src/example.ts", side: "additions", start: 11, end: 11, body: "Edited feedback." });
    const reopened = await new ReviewStore(store.root).read(next.id);
    assert.equal(reopened.comments[0].body, "Edited feedback.");
    assert.match(markdown(reopened), /src\/example\.ts/);
    assert.match(markdown(reopened), /New lines 11/);
    assert.match(markdown(reopened), /```typescript\nconst value = 2;\n```\n\nEdited feedback\./);
    await caller.deleteComment({ id: next.id, commentId: original.comments[0].id });
    assert.equal((await store.read(original.id)).comments.length, 0);
    assert.equal((await store.save(original)).comments.length, 0);
  }));


test("migrates comments from existing snapshot files without duplicating them", async () => {
  const root = await mkdtemp(join(tmpdir(), "pr-review-migrate-"));
  try {
    const store = new ReviewStore(root);
    const first = { ...fixture(), comments: [{ id: "legacy-comment", file: "src/example.ts", side: "additions" as const, start: 11, end: 11, code: "const value = 2;", body: "Legacy feedback", createdAt: "2026-01-01" }] };
    const second = { ...fixture(), id: "b".repeat(24) };
    for (const review of [first, second]) {
      await mkdir(store.path(review.id), { recursive: true });
      await writeFile(join(store.path(review.id), "review.json"), JSON.stringify(review));
    }
    const migrated = await store.save(await store.read(second.id));
    assert.equal(migrated.comments.length, 1);
    assert.equal(migrated.comments[0].snapshotId, first.id);
    assert.equal((await store.read(first.id)).comments.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("agent replies sync from disk and tRPC without being erased by comment edits", () =>
  usingStore(async (store) => {
    const caller = createRouter(store).createCaller({});
    const review = await caller.saveComment({ id: fixture().id, file: "src/example.ts", side: "additions", start: 11, end: 11, body: "Please fix this." });
    const commentId = review.comments[0].id;
    const state = await caller.comments({ id: review.id });
    const replies = [{ id: "external-reply", commentId, author: "Agent", body: "Fixed the edge case.\nAdded a test.", createdAt: new Date().toISOString() }];
    await writeFile(join(state.directory, "replies.json"), JSON.stringify(replies));
    assert.equal((await caller.comments({ id: review.id })).comments[0].replies?.[0].body, replies[0].body);
    await caller.saveComment({ id: review.id, commentId, file: "src/example.ts", side: "additions", start: 11, end: 11, body: "Updated request." });
    assert.equal((await caller.comments({ id: review.id })).comments[0].replies?.length, 1);
    await caller.reply({ id: review.id, commentId, author: "Agent", body: "Verified again." });
    assert.equal((await caller.comments({ id: review.id })).comments[0].replies?.length, 2);
    assert.match((await caller.export({ id: review.id })).markdown, /Fixed the edge case/);
    await writeFile(join(state.directory, "replies.json"), "invalid json");
    await assert.rejects(caller.comments({ id: review.id }), /Cannot read replies/);
    assert.equal(await readFile(join(state.directory, "replies.json"), "utf8"), "invalid json");
  }));

test("resolution persists across snapshots and syncs external changes", () =>
  usingStore(async (store) => {
    const caller = createRouter(store).createCaller({});
    const original = await caller.saveComment({ id: fixture().id, file: "src/example.ts", side: "additions", start: 11, end: 11, body: "Resolve me." });
    const commentId = original.comments[0].id;
    const resolved = await caller.resolveComment({ id: original.id, commentId, resolved: true });
    assert.equal(resolved.comments[0].resolved, true);
    const next = await store.save({ ...fixture(), id: "b".repeat(24), revision: "new-head" });
    assert.equal(next.comments[0].resolved, true);
    assert.match((await caller.export({ id: next.id })).markdown, /Resolved/);
    await caller.resolveComment({ id: next.id, commentId, resolved: false });
    assert.equal((await store.read(original.id)).comments[0].resolved, false);
    await writeFile(join(store.prDirectory(original), "resolved.json"), JSON.stringify({ [commentId]: true }));
    assert.equal((await caller.comments({ id: original.id })).comments[0].resolved, true);
    await assert.rejects(caller.resolveComment({ id: original.id, commentId: "missing", resolved: true }), /Unknown comment/);
  }));
