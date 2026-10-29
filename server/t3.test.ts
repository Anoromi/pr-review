import test from "node:test";
import assert from "node:assert/strict";
import { matchThreads, runState, type ShellThread } from "./t3";
import { awaitingReply, threadState } from "../shared/progress";
import { followUpMessage } from "./router";
import type { Comment, Review } from "../shared/types";

test("threads match by worktree or project root and sort by last activity", () => {
  const thread = (id: string, extra: Partial<ShellThread>): ShellThread => ({
    id, projectId: "p", title: id, worktreePath: null, updatedAt: "2026-01-01T00:00:00Z", archivedAt: null, ...extra,
  });
  const shell = {
    projects: [{ id: "p", workspaceRoot: "/repo" }, { id: "q", workspaceRoot: "/other" }],
    threads: [
      thread("root", { latestUserMessageAt: "2026-01-02T00:00:00Z" }),
      // Renamed recently, but last ran earlier: activity, not updatedAt, orders it.
      thread("worktree", { worktreePath: "/wt/", updatedAt: "2026-01-09T00:00:00Z", latestRunCompletedAt: "2026-01-03T00:00:00Z" }),
      thread("archived", { worktreePath: "/wt", archivedAt: "2026-01-05T00:00:00Z" }),
      thread("deleted", { worktreePath: "/wt", deletedAt: "2026-01-05T00:00:00Z" }),
      thread("elsewhere", { projectId: "q" }),
      thread("idle", { worktreePath: "/wt", updatedAt: "2026-01-01T12:00:00Z" }),
      // A provider-run subagent cannot take messages; a delegate_task child can.
      thread("subagent", { worktreePath: "/wt", latestRunCompletedAt: "2026-01-08T00:00:00Z", lineage: { relationshipToParent: "subagent" }, creationSource: "provider" }),
      thread("delegated", { worktreePath: "/wt", latestRunCompletedAt: "2026-01-07T00:00:00Z", lineage: { relationshipToParent: "subagent" }, creationSource: "mcp" }),
    ],
  };
  assert.deepEqual(matchThreads(shell, ["/wt"]).map((thread) => [thread.id, thread.updatedAt]), [
    ["delegated", "2026-01-07T00:00:00Z"],
    ["worktree", "2026-01-03T00:00:00Z"],
    ["idle", "2026-01-01T12:00:00Z"],
  ]);
  assert.deepEqual(matchThreads(shell, ["/link", "/repo/"]).map((thread) => thread.id), ["root"]);
});

test("a follow-up carries only the latest reply, a pointer to the conversation and reply instructions", () => {
  const review = { id: "r1", title: "Branch" } as Review;
  const comment = { id: "c1", file: "src/a.rs", side: "additions", start: 4, end: 5, code: "fn a() {}", body: "Why sync?" } as Comment;
  const message = followUpMessage(review, comment, "Is there really\nno way?", "/pr");
  assert.match(message, /^Follow-up from pr-review on src\/a\.rs, new lines 4-5, in the review "Branch"\. .*comment c1 in \/pr\/comments\.json, with replies in \/pr\/replies\.json\.\n\n> Is there really\n> no way\?\n/);
  assert.doesNotMatch(message, /Why sync\?|fn a\(\)/);
  assert.match(message, /"commentId":"c1"/);
});

test("a message's run is requested until a run is going, then finished once one completes after it", () => {
  const since = "2026-01-02T00:00:00.000Z";
  const thread = (extra: Partial<ShellThread>): ShellThread => ({
    id: "t", projectId: "p", title: "t", worktreePath: null, updatedAt: since, archivedAt: null, ...extra,
  });
  assert.equal(runState(thread({ latestRunCompletedAt: "2026-01-01T00:00:00.000Z" }), since), "requested");
  // A busy thread steered with the message counts as working on it.
  assert.equal(runState(thread({ activeRunId: "r", latestRunStartedAt: "2026-01-01T00:00:00.000Z" }), since), "working");
  assert.equal(runState(thread({ latestRunCompletedAt: "2026-01-02T00:01:00.000Z" }), since), "finished");
  assert.equal(runState(undefined, since), "finished");
});

test("an asked comment awaits a reply from its question or the user's latest follow-up until another author answers", () => {
  const reply = (author: string, createdAt: string) => ({ id: createdAt, commentId: "c", author, body: "b", createdAt });
  const comment = (replies: ReturnType<typeof reply>[], extra: Partial<Comment> = {}) =>
    ({ id: "c", thread: { id: "t", title: "T" }, createdAt: "1", replies, ...extra }) as Comment;
  assert.equal(awaitingReply(comment([])), "1");
  assert.equal(awaitingReply(comment([reply("Agent", "2")])), undefined);
  assert.equal(awaitingReply(comment([reply("Agent", "2"), reply("You", "3")])), "3");
  assert.equal(awaitingReply(comment([reply("Agent", "2"), reply("You", "3"), reply("Agent", "4")])), undefined);
  assert.equal(awaitingReply(comment([], { thread: undefined })), undefined);
});

test("a thread's state: new replies first, then resolved, then owed a reply (working or waiting), answered or open", () => {
  const asked = { id: "1", file: "a", side: "additions" as const, start: 1, end: 1, code: "", body: "Why?", createdAt: "2026-01-01T00:00:00Z", thread: { id: "t", title: "T" } };
  const answered = { ...asked, replies: [{ id: "r", commentId: "1", author: "Agent", body: "Because", createdAt: "2026-01-01T00:01:00Z" }] };
  assert.equal(threadState(asked, "working", 0), "working");
  assert.equal(threadState(asked, "requested", 0), "waiting");
  assert.equal(threadState(asked, "finished", 0), "waiting");
  assert.equal(threadState(answered, undefined, 1), "new");
  assert.equal(threadState(answered, undefined, 0), "answered");
  assert.equal(threadState({ ...answered, resolved: true }, undefined, 0), "resolved");
  assert.equal(threadState({ ...asked, thread: undefined }, undefined, 0), "open");
});
