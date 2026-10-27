import type { Comment } from "./types";

/**
 * When the user last wrote on a question to an agent thread (the question or
 * their latest reply, which `followUp` sends on), if no other author has
 * answered since: the agent owes a reply.
 */
export function awaitingReply(comment: Comment): string | undefined {
  if (!comment.thread || comment.github) return undefined;
  const replies = comment.replies ?? [];
  const asked = [comment.createdAt, ...replies.filter((reply) => reply.author === "You").map((reply) => reply.createdAt)].sort().at(-1)!;
  return replies.some((reply) => reply.author !== "You" && reply.createdAt >= asked) ? undefined : asked;
}

/** Where a thread stands, for the inbox groups and its marker in the diff. */
export type ThreadState = "new" | "working" | "waiting" | "open" | "answered" | "resolved";

/**
 * `run` is the agent thread's state for a question still owed a reply (see
 * `runState`), `unread` the replies the reader has not seen.
 */
export function threadState(comment: Comment, run: "requested" | "working" | "finished" | undefined, unread: number): ThreadState {
  if (unread > 0) return "new";
  if (comment.resolved) return "resolved";
  if (awaitingReply(comment)) return run === "working" ? "working" : "waiting";
  const others = (comment.replies ?? []).some((reply) => reply.author !== "You");
  return others ? "answered" : "open";
}
