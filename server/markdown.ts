import { extname } from "node:path";
import type { Review } from "../shared/types";

function inline(value: string) {
  return value.replace(/[\r\n]+/g, " ").replace(/([\\`*_{}\[\]<>#])/g, "\\$1");
}

export function markdown(review: Review): string {
  const output = [
    `# Review: ${inline(review.title)}`,
    "",
    `Source: ${review.source.url}`,
    `Revision: ${review.revision}`,
    `Base revision: ${review.baseRevision}`,
    "",
  ];
  if (review.source.kind === "local")
    output.splice(
      6,
      0,
      `Local repository: ${inline(review.source.repo)}`,
      `Branch: ${inline(review.source.branch)}`,
      `Snapshot: ${review.id}`,
      review.source.worktree
        ? `Working tree: ${inline(review.source.worktree)}`
        : "Committed branch changes",
      "",
    );
  const grouped = Map.groupBy(review.comments, (comment) => comment.file);
  for (const [file, comments] of grouped) {
    output.push(`## ${inline(file)}`, "");
    for (const comment of comments) {
      const range =
        comment.start === comment.end
          ? `${comment.start}`
          : `${comment.start}-${comment.end}`;
      const longestFence = Math.max(
        2,
        ...(comment.code.match(/`+/g) ?? []).map((match) => match.length),
      );
      const fence = "`".repeat(longestFence + 1);
      const extension = extname(file).slice(1).toLowerCase();
      const language = ({ ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", rs: "rust", py: "python", sh: "bash", yml: "yaml" } as Record<string, string>)[extension] ?? (/^[a-z0-9]+$/.test(extension) ? extension : "");
      output.push(
        `### ${comment.side === "deletions" ? "Old" : "New"} lines ${range}`,
        "",
        ...(comment.resolved ? ["Resolved", ""] : []),
        ...(comment.snapshotId && comment.snapshotId !== review.id ? [`Original snapshot: ${comment.snapshotId}`, ""] : []),
        fence + language,
        comment.code,
        fence,
        "",
        comment.body,
        "",
        ...(comment.replies ?? []).flatMap((reply) => [`**${inline(reply.author)}**`, "", reply.body, ""]),
      );
    }
  }
  if (!review.comments.length) output.push("No comments yet.", "");
  return output.join("\n");
}
