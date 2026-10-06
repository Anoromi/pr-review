import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewStore } from "./store";
import { ReviewSync } from "./review-sync";
import type { Review } from "../shared/types";

const patch = "diff --git a/a.txt b/a.txt\nindex 7898192..6178079 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "github-review-test-"));
  const store = new ReviewStore(directory);
  const review: Review = { id: "a".repeat(24), title: "Test", source: { kind: "github", url: "https://github.com/example/repo/pull/1" }, revision: "b".repeat(40), baseRevision: "c".repeat(40), patch, viewed: [], updatedAt: new Date().toISOString(), comments: [
    { id: "local", snapshotId: "a".repeat(24), destination: "local", file: "a.txt", side: "additions", start: 1, end: 1, code: "b", body: "private", createdAt: new Date().toISOString() },
    { id: "draft", snapshotId: "a".repeat(24), destination: "github", file: "a.txt", side: "additions", start: 1, end: 1, code: "b", body: "public", createdAt: new Date().toISOString() },
  ] };
  await store.save(review, true);
  const remote = { head: review.revision, comments: [] as any[], reviews: [] as any[], resolved: false, loseResponse: false, failWrite: false, author: "someone", outdated: false };
  const writes: Array<{ path: string; body: any }> = [];
  const run = async (args: string[]) => {
    const path = args[1], method = args[args.indexOf("--method") + 1];
    const body = args.includes("--input") ? JSON.parse(await readFile(args[args.indexOf("--input") + 1], "utf8")) : undefined;
    if (args.includes("Accept: application/vnd.github.diff")) return patch;
    if (path === "user") return JSON.stringify({ login: "me" });
    if (path === "graphql") {
      if (body.query.startsWith("mutation")) { remote.resolved = !body.query.includes("unresolve"); writes.push({ path, body }); return JSON.stringify({ data: {} }); }
      return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: remote.comments.filter(c => !c.in_reply_to_id).map(c => ({ id: `thread-${c.id}`, isResolved: remote.resolved, isOutdated: remote.outdated, viewerCanResolve: true, viewerCanUnresolve: true, comments: { nodes: [{ databaseId: c.id }] } })), pageInfo: { hasNextPage: false } } } } } });
    }
    if (method === "GET") {
      if (path.includes("/issues/")) return "[]";
      if (path.includes("/comments?")) { const page = Number(new URL(`https://api.github.com/${path}`).searchParams.get("page")); return JSON.stringify(remote.comments.slice((page - 1) * 100, page * 100)); }
      if (path.includes("/reviews?")) return JSON.stringify(remote.reviews);
      return JSON.stringify({ head: { sha: remote.head }, user: { login: remote.author } });
    }
    writes.push({ path, body });
    if (remote.failWrite) throw new Error("network failed before result");
    if (method === "PATCH") remote.comments.find(c => path.endsWith(`/${c.id}`)).body = body.body;
    else if (path.endsWith("/replies")) remote.comments.push({ id: 100, in_reply_to_id: 1, body: body.body, user: { login: "me" }, created_at: review.updatedAt });
    else {
      remote.reviews.push({ id: 1, body: body.body, state: body.event, user: { login: "me" }, html_url: review.source.url });
      for (const [index, comment] of body.comments.entries()) remote.comments.push({ id: index + 1, path: comment.path, line: comment.line, start_line: comment.start_line, side: comment.side, body: comment.body, user: { login: "me" }, created_at: review.updatedAt, html_url: `${review.source.url}#discussion-${index}`, commit_id: review.revision });
    }
    if (remote.loseResponse) throw new Error("connection lost after write");
    return "{}";
  };
  return { store, review, remote, writes, service: new ReviewSync(store, run), close: () => rm(directory, { recursive: true, force: true }) };
}

test("publishes only GitHub drafts, imports without duplicates, preserves local comments and remote edits/replies/resolution", async () => {
  const f = await fixture();
  try {
    const result = await f.service.submit(f.review.id, "COMMENT", "summary");
    assert.equal(f.writes[0].body.comments.length, 1);
    assert.equal(f.writes[0].body.comments[0].side, "RIGHT");
    assert.equal(f.writes[0].body.commit_id, f.review.revision);
    assert.ok(!JSON.stringify(f.writes).includes("private"));
    assert.equal(result.comments.length, 2);
    assert.equal(result.comments.find(c => c.id === "draft")?.github?.id, 1);
    await f.service.sync(f.review.id, true);
    assert.equal((await f.store.read(f.review.id)).comments.length, 2);
    await f.service.reply(f.review.id, "draft", "reply");
    assert.equal((await f.store.read(f.review.id)).comments.find(c => c.id === "draft")?.replies?.[0].body, "reply");
    await f.service.resolve(f.review.id, "draft", true);
    assert.equal((await f.store.read(f.review.id)).comments.find(c => c.id === "draft")?.resolved, true);
    await f.service.edit(f.review.id, "draft", "edited", "public");
    assert.equal((await f.store.read(f.review.id)).comments.find(c => c.id === "draft")?.body, "edited");
    f.remote.comments[0].body = "changed remotely";
    await assert.rejects(f.service.edit(f.review.id, "draft", "local draft", "edited"), /changed on GitHub/);
    await f.store.update(f.review.id, review => { review.viewed = ["a.txt"]; });
    assert.equal((await f.store.read(f.review.id)).comments.length, 2);
    f.remote.comments = [];
    await f.service.sync(f.review.id, true);
    const deleted = (await f.store.read(f.review.id)).comments.find(c => c.id === "draft");
    assert.equal(deleted?.github?.deleted, true);
    assert.equal(deleted?.body, "changed remotely");
  } finally { await f.close(); }
});

test("reconciles a lost submission response without posting twice", async () => {
  const f = await fixture();
  try {
    f.remote.loseResponse = true;
    await assert.rejects(f.service.submit(f.review.id, "COMMENT", "summary"));
    assert.ok((await f.store.read(f.review.id)).github?.pending);
    f.remote.loseResponse = false;
    await f.service.submit(f.review.id, "COMMENT", "summary");
    assert.equal(f.writes.length, 1);
    assert.equal((await f.store.read(f.review.id)).github?.pending, undefined);
  } finally { await f.close(); }
});

test("blocks unknown writes, changed heads, invalid anchors and self approval", async () => {
  const f = await fixture();
  try {
    f.remote.head = "d".repeat(40);
    await assert.rejects(f.service.submit(f.review.id, "COMMENT", "summary"), /head differs/);
    f.remote.head = f.review.revision;
    f.remote.author = "me";
    await assert.rejects(f.service.submit(f.review.id, "APPROVE", ""), /own PR/);
    await f.store.update(f.review.id, review => { review.comments[1].code = "wrong code"; });
    await assert.rejects(f.service.submit(f.review.id, "COMMENT", "summary"), /do not match/);
    await f.store.update(f.review.id, review => { review.comments[1].code = "b"; });
    f.remote.failWrite = true;
    await assert.rejects(f.service.submit(f.review.id, "COMMENT", "summary"));
    await assert.rejects(f.service.submit(f.review.id, "COMMENT", "summary"), /unknown outcome/);
    assert.equal(f.writes.length, 1);
  } finally { await f.close(); }
});

test("pulls externally created threads, changed resolutions and outdated state", async () => {
  const f = await fixture();
  try {
    f.remote.comments.push({ id: 8, path: "a.txt", side: "LEFT", line: 1, body: "external", user: { login: "reviewer" }, created_at: f.review.updatedAt, html_url: "https://github.com/example/repo/pull/1#discussion-8", commit_id: f.review.revision });
    let result = await f.service.sync(f.review.id, true);
    assert.equal(result.comments.length, 3);
    assert.equal(result.comments.find(c => c.id === "github-8")?.side, "deletions");
    assert.equal(result.comments.find(c => c.id === "github-8")?.github?.canEdit, false);
    f.remote.resolved = true; f.remote.outdated = true;
    result = await f.service.sync(f.review.id, true);
    assert.equal(result.comments.find(c => c.id === "github-8")?.resolved, true);
    assert.equal(result.comments.find(c => c.id === "github-8")?.github?.outdated, true);
    assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test("local comments stay local after synchronization and an agent reply", async () => {
  const f = await fixture();
  try {
    await f.service.sync(f.review.id, true);
    await f.store.reply(f.review.id, "local", "Agent", "private reply");
    await f.store.resolveComment(f.review.id, "local", true);
    const result = await f.service.sync(f.review.id, true);
    const comment = result.comments.find(c => c.id === "local");
    assert.equal(comment?.resolved, true);
    assert.equal(comment?.replies?.[0].body, "private reply");
    assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});


test("imports every page of comments and retains deleted replies", async () => {
  const f = await fixture();
  try {
    for (let i = 1; i <= 105; i++) f.remote.comments.push({ id: i, path: "a.txt", side: "RIGHT", line: 1, body: `comment ${i}`, user: { login: "reviewer" }, created_at: f.review.updatedAt, html_url: f.review.source.url, commit_id: f.review.revision });
    f.remote.comments.push({ id: 200, in_reply_to_id: 1, body: "reply history", user: { login: "reviewer" }, created_at: f.review.updatedAt });
    let result = await f.service.sync(f.review.id, true);
    assert.equal(result.comments.length, 107);
    assert.equal(result.comments.find(c => c.id === "github-1")?.replies?.[0].body, "reply history");
    f.remote.comments.pop();
    result = await f.service.sync(f.review.id, true);
    assert.equal(result.comments.find(c => c.id === "github-1")?.replies?.[0].deleted, true);
    assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test("preview flags mismatched draft locations without publishing", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.service.preview(f.review.id), [{ id: "draft", error: undefined }]);
    await f.store.update(f.review.id, review => { review.comments[1].code = "local-only edit"; });
    assert.match((await f.service.preview(f.review.id))[0].error!, /do not match/);
    assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});


test("a retry remains idempotent after background polling has reconciled the write", async () => {
  const f = await fixture();
  try {
    const requestId = "11111111-1111-4111-8111-111111111111";
    f.remote.loseResponse = true;
    await assert.rejects(f.service.submit(f.review.id, "COMMENT", "summary", requestId));
    f.remote.loseResponse = false;
    await f.service.sync(f.review.id, true);
    await f.service.submit(f.review.id, "COMMENT", "summary", requestId);
    assert.equal(f.writes.length, 1);
    const replyId = "22222222-2222-4222-8222-222222222222";
    await f.service.reply(f.review.id, "draft", "reply", replyId);
    await f.service.sync(f.review.id, true);
    await f.service.reply(f.review.id, "draft", "reply", replyId);
    assert.equal(f.writes.length, 2);
  } finally { await f.close(); }
});
