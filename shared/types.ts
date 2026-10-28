export type Source =
  | { kind: "github"; url: string }
  | {
      kind: "local";
      url: string;
      repo: string;
      branch: string;
      baseBranch: string;
      worktree?: string;
      branchReview?: boolean;
      branchComparison?: boolean;
      commit?: string;
      /** A branch review of a worktree with uncommitted files: `commit` is a snapshot of them on top of `head` (see worktreeState in server/branches.ts). */
      uncommitted?: { head: string; files: number };
      /** A T3 Code thread's own changes in turns `from` to `to` (see server/changes.ts). */
      changes?: { threadId: string; from: number; to: number };
    };

export interface GitHubComment {
  id: number;
  threadId: string;
  url: string;
  author: string;
  body: string;
  outdated: boolean;
  deleted?: boolean;
  canEdit: boolean;
  canResolve: boolean;
  commit: string;
}
export interface GitHubState {
  url: string;
  account?: string;
  author?: string;
  head?: string;
  syncedAt?: string;
  completedOperations?: string[];
  error?: string;
  comments: Comment[];
  reviews: Array<{ id: number; author: string; body: string; state: string; url: string }>;
  pending?: { id: string; kind: "review" | "reply"; payload: Record<string, unknown>; commentIds?: string[]; commentId?: string; attempted: boolean };
}

export interface Reply {
  deleted?: boolean;
  id: string;
  commentId: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface Comment {
  destination?: "local" | "github";
  /** The T3 Code thread this question was sent to (see the `ask` mutation). */
  thread?: { id: string; title: string };
  github?: GitHubComment;
  resolved?: boolean;
  replies?: Reply[];
  snapshotId?: string;
  id: string;
  file: string;
  side: "additions" | "deletions";
  start: number;
  end: number;
  code: string;
  body: string;
  createdAt: string;
}

export interface Review {
  id: string;
  title: string;
  source: Source;
  revision: string;
  baseRevision: string;
  patch: string;
  generatedFiles?: string[];
  github?: GitHubState;
  comments: Comment[];
  updatedAt: string;
}

export type ReviewSummary = Pick<
  Review,
  "id" | "title" | "source" | "revision" | "baseRevision" | "updatedAt"
> & {
  commentCount: number;
};

/** The commit a snapshot shows on its own (a commit scope of its branch or PR), if it does. */
export function commitOf(review: Pick<Review, "source">): string | undefined {
  return review.source.kind === "local" && !review.source.branchComparison ? review.source.commit : undefined;
}
