import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Comment, GitHubState, Review } from "../shared/types";
import { parseFiles, selectedCode } from "../shared/diff";
import { gh, parsePullUrl } from "./github";
import { ReviewStore } from "./store";

type Run = typeof gh;
const marker = (id: string) => `<!-- pr-review:${id} -->`;
export const cleanBody = (body: string) => body.replace(/\n*<!-- pr-review:[\w-]+ -->/g, "");
const bodyId = (body: string) => /<!-- pr-review:([\w-]+) -->\s*$/.exec(body)?.[1];

export class ReviewSync {
  constructor(private store: ReviewStore, private run: Run = gh) {}
  private async api(path: string, method = "GET", body?: unknown) {
    if (body === undefined) return JSON.parse(await this.run(["api", path, "--method", method]));
    const directory = await mkdtemp(join(tmpdir(), "pr-review-api-"));
    try {
      const file = join(directory, "body.json");
      await writeFile(file, JSON.stringify(body), { mode: 0o600 });
      return JSON.parse(await this.run(["api", path, "--method", method, "--input", file]) || "null");
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  private async pages(path: string): Promise<any[]> {
    const all = [];
    for (let page = 1; ; page++) {
      const rows = await this.api(`${path}?per_page=100&page=${page}`);
      all.push(...rows);
      if (rows.length < 100) return all;
    }
  }
  private endpoint(state: GitHubState) {
    const { owner, repo, number } = parsePullUrl(state.url);
    return `repos/${owner}/${repo}/pulls/${number}`;
  }
  private async state(review: Review) {
    const existing = await this.store.readGitHub(review);
    if (existing) return existing;
    parsePullUrl(review.source.url);
    return { url: review.source.url, comments: [], reviews: [] } satisfies GitHubState;
  }
  async link(id: string, url: string) {
    return this.store.transaction(async () => {
      const review = await this.store.read(id);
      const { owner, repo, number } = parsePullUrl(url);
      const canonical = `https://github.com/${owner}/${repo}/pull/${number}`;
      const existing = await this.store.readGitHub(review);
      if (existing && existing.url !== canonical) throw new Error("This conversation is already linked to another PR.");
      if (!(review.source.kind === "local" && review.source.branchReview) && canonical !== review.source.url) throw new Error("Use the PR associated with this review.");
      const state = existing ?? { url: canonical, comments: [], reviews: [] };
      await this.pull(review, state);
      return this.store.read(id);
    });
  }
  async sync(id: string, force = false) {
    return this.store.transaction(async () => {
      const review = await this.store.read(id);
      let state: GitHubState;
      try { state = await this.state(review); } catch { return review; }
      if (!force && state.syncedAt && Date.now() - Date.parse(state.syncedAt) < 4500) return review;
      try { await this.pull(review, state); }
      catch (error) {
        state.error = error instanceof Error ? error.message : String(error);
        await this.store.writeGitHub(review, state);
      }
      return this.store.read(id);
    });
  }
  private async pull(review: Review, state: GitHubState) {
    const endpoint = this.endpoint(state);
    const { owner, repo, number } = parsePullUrl(state.url);
    const [pull, account, comments, reviews, discussion] = await Promise.all([
      this.api(endpoint), this.api("user"), this.pages(`${endpoint}/comments`), this.pages(`${endpoint}/reviews`),
      this.pages(`repos/${owner}/${repo}/issues/${number}/comments`),
    ]);
    const threads = new Map<number, any>();
    let cursor: string | null = null;
    do {
      const response = await this.api("graphql", "POST", { query: `query($owner:String!,$repo:String!,$number:Int!,$cursor:String) {
        repository(owner:$owner,name:$repo) { pullRequest(number:$number) { reviewThreads(first:100,after:$cursor) {
          nodes { id isResolved isOutdated viewerCanResolve viewerCanUnresolve comments(first:1) { nodes { databaseId } } }
          pageInfo { hasNextPage endCursor }
        } } }
      }`, variables: { owner, repo, number, cursor } });
      if (response.errors) throw new Error(response.errors.map((error: any) => error.message).join("; "));
      const connection = response.data.repository.pullRequest.reviewThreads;
      for (const thread of connection.nodes) threads.set(thread.comments.nodes[0]?.databaseId, thread);
      cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (cursor);
    const local = review.comments;
    const previous = new Map(state.comments.map(comment => [comment.github!.id, comment]));
    state.comments = comments.filter(comment => !comment.in_reply_to_id).map(remote => {
      const thread = threads.get(remote.id);
      const draftId = bodyId(remote.body);
      const original = previous.get(remote.id) ?? local.find(comment => comment.id === draftId && comment.destination === "github");
      const start = remote.start_line ?? remote.original_start_line ?? remote.line ?? remote.original_line ?? 1;
      return {
        id: original?.id ?? `github-${remote.id}`, snapshotId: original?.snapshotId,
        file: remote.path, side: remote.side === "LEFT" ? "deletions" : "additions",
        start, end: remote.line ?? remote.original_line ?? start, code: original?.code ?? remote.diff_hunk ?? "",
        body: cleanBody(remote.body), destination: "github", createdAt: remote.created_at,
        resolved: thread?.isResolved ?? false,
        github: { id: remote.id, threadId: thread?.id ?? "", url: remote.html_url, author: remote.user.login,
          body: cleanBody(remote.body), outdated: thread?.isOutdated ?? !remote.line,
          canEdit: remote.user.login === account.login,
          canResolve: Boolean(thread?.isResolved ? thread.viewerCanUnresolve : thread?.viewerCanResolve), commit: remote.commit_id },
        replies: [...comments.filter(reply => reply.in_reply_to_id === remote.id).map(reply => ({
          id: `github-${reply.id}`, commentId: original?.id ?? `github-${remote.id}`, author: reply.user.login,
          body: cleanBody(reply.body), createdAt: reply.created_at,
        })), ...(original?.replies ?? []).filter(reply => reply.id.startsWith("github-") && !comments.some(remoteReply => `github-${remoteReply.id}` === reply.id)).map(reply => ({ ...reply, deleted: true }))],
      } satisfies Comment;
    });
    const present = new Set(state.comments.map(comment => comment.github!.id));
    for (const old of previous.values()) if (!present.has(old.github!.id)) state.comments.push({ ...old, github: { ...old.github!, deleted: true, canEdit: false, canResolve: false } });
    state.reviews = [...reviews.filter(item => item.state !== "PENDING").map(item => ({ id: item.id, author: item.user?.login ?? "Deleted user", body: cleanBody(item.body ?? ""), state: item.state, url: item.html_url })),
      ...discussion.map(item => ({ id: item.id, author: item.user.login, body: item.body, state: "COMMENT", url: item.html_url }))];
    state.completedOperations = [...new Set([...(state.completedOperations ?? []), ...reviews.map(item => bodyId(item.body ?? "")).filter((id): id is string => Boolean(id)), ...comments.filter(item => item.in_reply_to_id).map(item => bodyId(item.body ?? "")).filter((id): id is string => Boolean(id))])];
    const pending = state.pending;
    if (pending?.attempted && (pending.kind === "review" ? reviews : comments).some(item => item.body?.includes(marker(pending.id)))) state.pending = undefined;
    state.account = account.login; state.author = pull.user.login; state.head = pull.head.sha;
    state.syncedAt = new Date().toISOString(); state.error = undefined;
    await this.store.writeGitHub(review, state);
  }
  private async reconcile(review: Review, state: GitHubState) {
    await this.pull(review, state);
    if (state.pending?.attempted) throw new Error("A previous submission has an unknown outcome. Check GitHub and sync again before sending anything else.");
  }
  async preview(id: string) {
    const review = await this.store.read(id);
    const state = await this.state(review);
    const head = (await this.api(this.endpoint(state))).head.sha as string;
    const patch = await this.run(["api", this.endpoint(state), "-H", "Accept: application/vnd.github.diff"]);
    const files = parseFiles(patch);
    const results = [];
    for (const comment of review.comments.filter(comment => comment.destination === "github" && !comment.github)) {
      let error: string | undefined;
      try {
        const snapshot = await this.store.read(comment.snapshotId ?? review.id);
        if (snapshot.revision !== head) throw new Error("This draft belongs to an older commit. Refresh and reattach it.");
        const file = files.find(file => file.name === comment.file);
        if (!file || selectedCode(file, comment.side, comment.start, comment.end) !== comment.code) throw new Error("These lines do not match the PR diff. Select their current location and recreate the comment.");
      } catch (err) { error = err instanceof Error ? err.message : String(err); }
      results.push({ id: comment.id, error });
    }
    return results;
  }

  async submit(id: string, event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string, requestId: string = randomUUID()) {
    return this.store.transaction(async () => {
      const review = await this.store.read(id);
      const state = await this.state(review);
      const wasPending = state.pending?.attempted;
      await this.reconcile(review, state);
      if (wasPending || state.completedOperations?.includes(requestId)) return this.store.read(id);
      if (state.head !== review.revision) throw new Error("The PR head differs from this snapshot. Refresh and review the latest diff before submitting.");
      if (event !== "COMMENT" && state.account === state.author) throw new Error("GitHub does not allow approving or requesting changes on your own PR.");
      const remoteIds = new Set(state.comments.map(comment => comment.id));
      const drafts = review.comments.filter(comment => comment.destination === "github" && !comment.github && !remoteIds.has(comment.id));
      if (!body.trim() && !drafts.length && event !== "APPROVE") throw new Error("Add a review summary or a GitHub comment.");
      if (event === "REQUEST_CHANGES" && !body.trim()) throw new Error("Describe the requested changes in the review summary.");
      const patch = await this.run(["api", this.endpoint(state), "-H", "Accept: application/vnd.github.diff"]);
      const files = parseFiles(patch);
      const comments = [];
      for (const draft of drafts) {
        const snapshot = await this.store.read(draft.snapshotId ?? review.id);
        if (snapshot.revision !== state.head) throw new Error(`Refresh and reattach the draft on ${draft.file}; it belongs to an older commit.`);
        const file = files.find(file => file.name === draft.file);
        if (!file || selectedCode(file, draft.side, draft.start, draft.end) !== draft.code) throw new Error(`The selected lines in ${draft.file} do not match the PR diff. Reattach this draft before submitting.`);
        const side = draft.side === "additions" ? "RIGHT" : "LEFT";
        comments.push({ path: draft.file, body: `${draft.body}\n\n${marker(draft.id)}`, line: draft.end, side,
          ...(draft.start !== draft.end ? { start_line: draft.start, start_side: side } : {}) });
      }
      const latest = await this.api(this.endpoint(state));
      if (latest.head.sha !== state.head) throw new Error("The PR changed while preparing this review. Refresh before submitting.");
      const operation = requestId;
      state.pending = { id: operation, kind: "review", attempted: true, commentIds: drafts.map(comment => comment.id),
        payload: { commit_id: state.head, event, body: `${body.trim()}\n\n${marker(operation)}`, comments } };
      await this.store.writeGitHub(review, state);
      await this.api(`${this.endpoint(state)}/reviews`, "POST", state.pending.payload);
      await this.pull(review, state);
      return this.store.read(id);
    });
  }
  async reply(id: string, commentId: string, body: string, requestId: string = randomUUID()) {
    return this.store.transaction(async () => {
      const review = await this.store.read(id);
      const state = await this.state(review);
      const wasPending = state.pending?.attempted;
      await this.reconcile(review, state);
      if (wasPending || state.completedOperations?.includes(requestId)) return this.store.read(id);
      const comment = state.comments.find(comment => comment.id === commentId);
      if (!comment?.github || comment.github.deleted) throw new Error("This GitHub thread is no longer available.");
      const operation = requestId;
      state.pending = { id: operation, kind: "reply", commentId, attempted: true, payload: { body: `${body}\n\n${marker(operation)}` } };
      await this.store.writeGitHub(review, state);
      await this.api(`${this.endpoint(state)}/comments/${comment.github.id}/replies`, "POST", state.pending.payload);
      await this.pull(review, state);
      return this.store.read(id);
    });
  }
  async edit(id: string, commentId: string, body: string, expectedBody: string) {
    return this.store.transaction(async () => {
      const review = await this.store.read(id); const state = await this.state(review);
      await this.pull(review, state);
      const comment = state.comments.find(comment => comment.id === commentId);
      if (!comment?.github?.canEdit || comment.github.deleted) throw new Error("This GitHub comment cannot be edited by your account.");
      if (comment.body !== expectedBody) throw new Error(`This comment changed on GitHub. Your draft is preserved. Current GitHub text:\n${comment.body}`);
      const { owner, repo } = parsePullUrl(state.url);
      await this.api(`repos/${owner}/${repo}/pulls/comments/${comment.github.id}`, "PATCH", { body: `${body}\n\n${marker(comment.id)}` });
      await this.pull(review, state); return this.store.read(id);
    });
  }
  async resolve(id: string, commentId: string, resolved: boolean) {
    return this.store.transaction(async () => {
      const review = await this.store.read(id); const state = await this.state(review);
      await this.pull(review, state);
      const comment = state.comments.find(comment => comment.id === commentId);
      if (!comment?.github || comment.github.deleted) throw new Error("This GitHub thread is no longer available.");
      if (comment.resolved !== resolved) {
        if (!comment.github.canResolve) throw new Error("Your GitHub account cannot resolve this thread.");
        const action = resolved ? "resolveReviewThread" : "unresolveReviewThread";
        const result = await this.api("graphql", "POST", { query: `mutation($id:ID!) { ${action}(input:{threadId:$id}) { thread { id isResolved } } }`, variables: { id: comment.github.threadId } });
        if (result.errors) throw new Error(result.errors.map((error: any) => error.message).join("; "));
      }
      await this.pull(review, state); return this.store.read(id);
    });
  }
  async clearUncertain(id: string) {
    return this.store.transaction(async () => {
      const review = await this.store.read(id); const state = await this.state(review);
      await this.pull(review, state);
      state.pending = undefined;
      await this.store.writeGitHub(review, state); return this.store.read(id);
    });
  }
}
