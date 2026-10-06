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
  viewed: string[];
  updatedAt: string;
}

export type ReviewSummary = Pick<
  Review,
  "id" | "title" | "source" | "revision" | "baseRevision" | "updatedAt"
> & {
  commentCount: number;
};
