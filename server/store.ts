import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Review, ReviewSummary, GitHubState } from "../shared/types";
import { z } from "zod";
import { markdown } from "./markdown";

export class ReviewStore {
  private queue: Promise<unknown> = Promise.resolve();
  readonly root: string;

  constructor(root = process.env.REVIEW_DIR ?? ".reviews") {
    this.root = resolve(root);
  }

  path(id: string) {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Invalid review ID.");
    return join(this.root, id);
  }

  async read(id: string): Promise<Review> {
    const review: Review = JSON.parse(
      await readFile(join(this.path(id), "review.json"), "utf8"),
    );
    const replies = await this.readReplies(review);
    const resolutions = await this.readResolutions(review);
    const github = await this.readGitHub(review);
    const local = (await this.prComments(review)).filter(comment => !comment.github);
    const remoteIds = new Set(github?.comments.map(comment => comment.id));
    return { ...review, github, comments: [
      ...local.filter(comment => !remoteIds.has(comment.id)).map(comment => ({ ...comment, resolved: resolutions[comment.id] ?? false, replies: replies.filter(reply => reply.commentId === comment.id) })),
      ...(github?.comments ?? []).map(comment => ({ ...comment, replies: [...(comment.replies ?? []), ...replies.filter(reply => reply.commentId === comment.id)] })),
    ] };
  }

  async readGitHub(review: Review): Promise<GitHubState | undefined> {
    try { return JSON.parse(await readFile(join(this.prDirectory(review), "github.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  async writeGitHub(review: Review, state: GitHubState) {
    const directory = this.prDirectory(review);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, join(directory, "github.json"));
  }

  prDirectory(review: Review) {
    if (review.source.kind === "local" && review.source.branchReview) {
      const key = createHash("sha256").update(JSON.stringify([review.source.repo, review.source.branch])).digest("hex").slice(0, 24);
      return join(this.root, "branches", key);
    }
    const key = createHash("sha256").update(review.source.url.replace(/\/$/, "").toLowerCase()).digest("hex").slice(0, 24);
    return join(this.root, "prs", key);
  }

  async readResolutions(review: Review): Promise<Record<string, boolean>> {
    try {
      return z.record(z.string(), z.boolean()).parse(JSON.parse(await readFile(join(this.prDirectory(review), "resolved.json"), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error("Cannot read resolved.json: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  async resolveComment(id: string, commentId: string, resolved: boolean) {
    return this.transaction(async () => {
      const review = await this.read(id);
      if (!review.comments.some((comment) => comment.id === commentId)) throw new Error("Unknown comment.");
      const state = await this.readResolutions(review);
      state[commentId] = resolved;
      const directory = this.prDirectory(review);
      await mkdir(directory, { recursive: true });
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
      await rename(temporary, join(directory, "resolved.json"));
      return this.read(id);
    });
  }

  async readReplies(review: Review) {
    try {
      const data = JSON.parse(await readFile(join(this.prDirectory(review), "replies.json"), "utf8"));
      return z.array(z.object({ id: z.string().min(1), commentId: z.string().min(1), author: z.string().min(1), body: z.string().min(1), createdAt: z.string().min(1) })).parse(data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error("Cannot read replies.json: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  async reply(id: string, commentId: string, author: string, body: string) {
    return this.transaction(async () => {
      const review = await this.read(id);
      if (!review.comments.some((comment) => comment.id === commentId)) throw new Error("Unknown comment.");
      const replies = await this.readReplies(review);
      replies.push({ id: randomUUID(), commentId, author, body, createdAt: new Date().toISOString() });
      const directory = this.prDirectory(review);
      await mkdir(directory, { recursive: true });
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(replies, null, 2) + "\n", { mode: 0o600 });
      await rename(temporary, join(directory, "replies.json"));
      return this.read(id);
    });
  }

  private async prComments(review: Review): Promise<Review["comments"]> {
    try {
      return JSON.parse(await readFile(join(this.prDirectory(review), "comments.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const snapshots: Review[] = [review];
    await mkdir(this.root, { recursive: true });
    for (const entry of await readdir(this.root)) {
      if (!/^[a-f0-9]{24}$/.test(entry) || entry === review.id) continue;
      try {
        const previous: Review = JSON.parse(await readFile(join(this.path(entry), "review.json"), "utf8"));
        if (this.prDirectory(previous) === this.prDirectory(review)) snapshots.push(previous);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const comments = new Map<string, Review["comments"][number]>();
    for (const snapshot of snapshots.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)))
      for (const comment of snapshot.comments)
        comments.set(comment.id, { ...comment, snapshotId: comment.snapshotId ?? snapshot.id });
    return [...comments.values()];
  }

  private async writePrComments(review: Review) {
    const directory = this.prDirectory(review);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try { await writeFile(join(directory, "replies.json"), "[]\n", { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await writeFile(join(directory, "AGENTS.md"), `# PR review conversation

Read comments.json for the user's requests. Each request has an id, repository-relative file, side, start/end line numbers, original code, body and snapshotId. pr.json identifies the review and branch when applicable. Read the captured code before applying a request to a newer revision.

Write replies to replies.json, a JSON array. Preserve existing replies. Each reply needs id (a new UUID), commentId (the request id), author, body and createdAt (ISO timestamp). Write to a temporary file in this directory and rename it over replies.json atomically. Do not edit comments.json or review.json to reply. The app reads replies through tRPC every two seconds. Replies are plain text; preserve newlines for code.

GitHub synchronization is stored in github.json beside these files. It contains imported threads, replies, review decisions and pending submission recovery data. Treat it as app-owned state; do not edit it directly. Local agent replies stay local unless the user explicitly requests publishing them.

Resolution state is in resolved.json, an object mapping comment IDs to true (resolved) or false (open). Preserve other entries and replace the file atomically. The app polls this file too.

For concurrent agents, use POST http://127.0.0.1:4319/trpc/reply with JSON {"id":"SNAPSHOT_ID","commentId":"COMMENT_ID","author":"Agent","body":"Your reply"}. Use snapshotId from the comment as id. This endpoint serializes replies from multiple agents. Direct file edits must have a single writer.
`, { mode: 0o600 });
    try { await writeFile(join(directory, "resolved.json"), "{}\n", { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const requests = review.comments.filter(comment => !comment.github).map(({ replies: _replies, resolved: _resolved, ...comment }) => comment);
    for (const [name, data] of [["comments.json", JSON.stringify(requests, null, 2) + "\n"], ["review.md", markdown(review)], ["pr.json", JSON.stringify({ url: review.source.url, title: review.title, snapshotId: review.id, source: review.source }, null, 2) + "\n"]]) {
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      await writeFile(temporary, data, { mode: 0o600 });
      await rename(temporary, join(directory, name));
    }
  }

  async migrateConversations() {
    return this.transaction(async () => {
      const seen = new Set<string>();
      let comments = 0;
      for (const summary of await this.list()) {
        const review = await this.read(summary.id);
        const directory = this.prDirectory(review);
        if (seen.has(directory)) continue;
        seen.add(directory);
        await this.writePrComments(review);
        comments += review.comments.length;
      }
      return { prs: seen.size, comments };
    });
  }

  async list(): Promise<ReviewSummary[]> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    const reviews = await Promise.all(
      entries
        .filter(
          (entry) => entry.isDirectory() && /^[a-f0-9]{24}$/.test(entry.name),
        )
        .map(async (entry) => {
          try {
            return JSON.parse(
              await readFile(
                join(this.path(entry.name), "summary.json"),
                "utf8",
              ),
            ) as ReviewSummary;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            return this.summary(await this.read(entry.name));
          }
        }),
    );
    return reviews.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async findCached(
    url: string,
    head: string,
    base: string,
  ): Promise<Review | undefined> {
    const summaries = await this.list();
    for (const summary of summaries) {
      if (
        summary.source.url !== url ||
        summary.revision !== head ||
        summary.baseRevision !== base
      )
        continue;
      const review = await this.read(summary.id);
      if (review.baseRevision === base) return review;
    }
  }

  private summary(review: Review): ReviewSummary {
    const { id, title, source, revision, baseRevision, updatedAt, comments } =
      review;
    return {
      id,
      title,
      source,
      revision,
      baseRevision,
      updatedAt,
      commentCount: comments.length,
    };
  }

  async save(review: Review, commentsChanged = false) {
    if (!commentsChanged) review = { ...review, comments: await this.prComments(review) };
    const replies = await this.readReplies(review);
    review = { ...review, comments: review.comments.map((comment) => ({ ...comment, replies: replies.filter((reply) => reply.commentId === comment.id) })) };
    await this.writePrComments(review);
    const directory = this.path(review.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // JSON is the source of truth; reopening repairs Markdown after an interrupted write.
    for (const [name, data] of [
      ["review.json", JSON.stringify(review)],
      ["review.md", markdown(review)],
      ["summary.json", JSON.stringify(this.summary(review))],
    ]) {
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      await writeFile(temporary, data, { mode: 0o600 });
      await rename(temporary, join(directory, name));
    }
    return this.read(review.id);
  }

  transaction<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  update(id: string, change: (review: Review) => void | Promise<void>) {
    return this.transaction(async () => {
      const review = await this.read(id);
      await change(review);
      review.updatedAt = new Date().toISOString();
      return this.save(review, true);
    });
  }
}
