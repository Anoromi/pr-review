import test from "node:test";
import assert from "node:assert/strict";
import { matchThreads, type ShellThread } from "./t3";

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
    ],
  };
  assert.deepEqual(matchThreads(shell, ["/wt"]).map((thread) => [thread.id, thread.updatedAt]), [
    ["worktree", "2026-01-03T00:00:00Z"],
    ["idle", "2026-01-01T12:00:00Z"],
  ]);
  assert.deepEqual(matchThreads(shell, ["/link", "/repo/"]).map((thread) => thread.id), ["root"]);
});
