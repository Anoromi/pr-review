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
