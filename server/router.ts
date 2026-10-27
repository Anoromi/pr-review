import { ReviewSync } from "./review-sync";
import { listBranches, listBranchAuthors, listBranchCommits, loadBranchCommit, loadBranchReview } from "./branches";
import { loadLocalReview, withGeneratedFiles } from "./local";
import { hydratePartialDiff } from "@pierre/diffs";
import { loadContext, readContext } from "./context";
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ReviewStore } from "./store";
import { readFilters, writeFilters } from "./filters";
import { localPullMetadata, listCheckoutPulls, listMyPulls, pullForBranch } from "./github";
import { checkoutRepo, currentBranch, githubRepo, githubRepoOrNull } from "./repository";
import { markdown } from "./markdown";
import { listThreads, readShell, runState, sendToThread, type ShellThread } from "./t3";
import { reviewMapSchema } from "../shared/map";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { apiUrl } from "./port";
import { hunkText, parseFiles, selectedCode } from "../shared/diff";
import { awaitingReply } from "../shared/progress";
import type { Comment, Review } from "../shared/types";

const t = initTRPC.create();
const idInput = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) });
// Which checkout a request works on (see checkoutRepo); omitted = the default.
const scoped = z.object({ checkout: z.string().min(1).max(4096).optional() });
const linesInput = idInput.extend({
  file: z.string().min(1).max(4096),
  side: z.enum(["additions", "deletions"]),
  start: z.number().int().positive(),
  end: z.number().int().positive(),
  body: z.string().trim().min(1).max(50_000),
});
const validRange = (input: { start: number; end: number }) => input.end >= input.start && input.end - input.start < 500;
const commentInput = linesInput
  .extend({
    commentId: z.string().min(1).optional(),
    destination: z.enum(["local", "github"]).optional(),
    expectedBody: z.string().optional(),
  })
  .refine(validRange, "Select between 1 and 500 lines.");
const askInput = linesInput.extend({ threadId: z.string().min(1) }).refine(validRange, "Select between 1 and 500 lines.");

export function createRouter(store: ReviewStore) {
  const sync = new ReviewSync(store);
  const procedure = t.procedure.use(async ({ next }) => {
    try {
      return await next();
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: error instanceof Error ? error.message : "Request failed.",
      });
    }
  });
  // The selected code and the diff hunks around it, from the file with its
  // loaded context so lines expanded outside the hunks count too.
  async function selectedLines(review: Review, input: { file: string; side: Comment["side"]; start: number; end: number }) {
    const file = parseFiles(review.patch).find((file) => file.name === input.file);
    if (!file) throw new Error("This file is not part of the review.");
    const context = await readContext(store.path(review.id), file.name);
    if (context) hydratePartialDiff("merge", file, context);
    return { code: selectedCode(file, input.side, input.start, input.end), hunks: hunkText(file, input.side, input.start, input.end) };
  }
  // The checkout the review's code lives in, where its agent threads work.
  function reviewCheckout(review: Review) {
    if (review.source.kind !== "local") throw new Error("Only reviews of a local checkout have agent threads.");
    return review.source.worktree ?? review.source.repo;
  }
  async function threadTitle(review: Review, threadId: string) {
    const thread = (await listThreads(reviewCheckout(review))).find((thread) => thread.id === threadId);
    if (!thread) throw new Error("That agent thread no longer works in this checkout.");
    return thread.title;
  }
  return t.router({
    // T3 Code threads working in the review's checkout, most recently active first.
    threads: procedure.input(idInput).query(async ({ input }) => listThreads(reviewCheckout(await store.read(input.id)))),
    // A question about lines of the diff, saved as a comment and sent to the
    // agent thread, which answers through the `reply` mutation.
    ask: procedure.input(askInput)
      .mutation(async ({ input }) => {
        const current = await store.read(input.id);
        const title = await threadTitle(current, input.threadId);
        const { code, hunks } = await selectedLines(current, input);
        const comment: Comment = {
          destination: "local", id: randomUUID(), snapshotId: current.id, thread: { id: input.threadId, title },
          file: input.file, side: input.side, start: input.start, end: input.end,
          body: input.body, code, createdAt: new Date().toISOString(),
        };
        // Sent first, so a failed send leaves no question that never arrived;
        // the agent takes far longer to answer than this takes to save.
        await sendToThread(input.threadId, askMessage(current, comment, hunks));
        return store.update(input.id, (review) => { review.comments.push(comment); });
      }),
    // Sends the user's latest reply on an asked comment to its agent thread as
    // a follow-up. Called after the reply is saved; the agent's own replies
    // come through `reply` and are never sent back.
    followUp: procedure.input(idInput.extend({ commentId: z.string().min(1) }))
      .mutation(async ({ input }) => {
        const current = await store.read(input.id);
        const comment = current.comments.find((comment) => comment.id === input.commentId);
        if (!comment?.thread) throw new Error("This comment was not asked of an agent thread.");
        // The user's latest reply (ReplyComposer posts as "You"), even if the agent answered since.
        const last = (comment.replies ?? []).findLastIndex((reply) => reply.author === "You");
        if (last < 0) throw new Error("This comment has no follow-up to send.");
        await sendToThread(comment.thread.id, followUpMessage(current, comment, comment.replies![last].body, store.prDirectory(current)));
      }),
    // The review map an agent wrote to map.json (see shared/map.ts), or null.
    map: procedure.input(idInput).query(async ({ input }) => {
      const file = join(store.prDirectory(await store.read(input.id)), "map.json");
      let text: string;
      try { text = await readFile(file, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
      try { return reviewMapSchema.parse(JSON.parse(text)); }
      catch (error) { throw new Error(`${file} is not a valid review map: ${error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : error}`); }
    }),
    // Asks the agent thread to write map.json for this review's diff.
    // The request is kept in map-request.json, so `progress` can follow it.
    requestMap: procedure.input(idInput.extend({ threadId: z.string().min(1) })).mutation(async ({ input }) => {
      const review = await store.read(input.id);
      const title = await threadTitle(review, input.threadId);
      const directory = store.prDirectory(review);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(directory, "map-diff.patch"), review.patch, { mode: 0o600 });
      const requestedAt = new Date().toISOString();
      await sendToThread(input.threadId, [
        `Run the review-map skill (~/.agents/skills/review-map/SKILL.md) for the review "${review.title}" in pr-review.`,
        "",
        `The diff to map is ${join(directory, "map-diff.patch")} (base ${review.baseRevision}, head ${review.revision}). Name hunks by the starts in its @@ headers.`,
        `Write the map to ${join(directory, "map.json")}. pr-review shows it as soon as the file is valid; an invalid file shows its errors there.`,
      ].join("\n"));
      await writeFile(join(directory, "map-request.json"), JSON.stringify({ threadId: input.threadId, title, requestedAt }) + "\n", { mode: 0o600 });
    }),
    // What the agent threads are doing with what was sent to them: the last
    // map request (ready once map.json changed after it) and the questions
    // still owed a reply. T3 Code is only asked while something is pending.
    progress: procedure.input(idInput).query(async ({ input }) => {
      const review = await store.read(input.id);
      const directory = store.prDirectory(review);
      let job: { threadId: string; title: string; requestedAt: string } | null = null;
      try { job = JSON.parse(await readFile(join(directory, "map-request.json"), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      let mapChanged = 0;
      try { mapChanged = (await stat(join(directory, "map.json"))).mtimeMs; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const mapReady = job !== null && mapChanged > Date.parse(job.requestedAt);
      const waiting = review.comments.flatMap((comment) => {
        const since = awaitingReply(comment);
        return since ? [{ id: comment.id, threadId: comment.thread!.id, since }] : [];
      });
      let threads = new Map<string, ShellThread>();
      let error: string | null = null;
      if ((job && !mapReady) || waiting.length) {
        try { threads = new Map((await readShell()).threads.map((thread) => [thread.id, thread])); }
        catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
      }
      // Without T3 Code's answer, everything pending stays "requested" next to the error.
      const state = (threadId: string, since: string) => error ? "requested" as const : runState(threads.get(threadId), since);
      return {
        error,
        map: job && { title: job.title, requestedAt: job.requestedAt, state: mapReady ? "ready" as const : state(job.threadId, job.requestedAt) },
        replies: Object.fromEntries(waiting.map((item) => [item.id, state(item.threadId, item.since)])),
      };
    }),
    branches: procedure.input(scoped.optional()).query(({ input }) => listBranches(checkoutRepo(input?.checkout))),
    branchAuthors: procedure.input(scoped.extend({ branch: z.string().min(1) })).query(({ input }) => listBranchAuthors(input.branch, checkoutRepo(input.checkout))),
    branchCommits: procedure.input(scoped.extend({ branch: z.string().min(1), author: z.string().min(1).max(1000).optional(), search: z.string().trim().max(1000).default(""), skip: z.number().int().nonnegative().default(0) })).query(({ input }) => listBranchCommits(input.branch, input.skip, checkoutRepo(input.checkout), input.author, input.search)),
    openCommit: procedure.input(scoped.extend({ branch: z.string().min(1), commit: z.string().regex(/^[a-f0-9]{40}$/) })).mutation(async ({ input }) => {
      const fresh = await loadBranchCommit(input.branch, input.commit, store, checkoutRepo(input.checkout));
      return store.transaction(async () => {
        try { return await store.read(fresh.id); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        return store.save(fresh);
      });
    }),
    openBranch: procedure.input(scoped.extend({ branch: z.string().min(1) })).mutation(async ({ input }) => {
      const fresh = await loadBranchReview(input.branch, store, checkoutRepo(input.checkout));
      return store.transaction(async () => {
        try { return await store.read(fresh.id); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        return store.save(fresh);
      });
    }),
    list: procedure.query(() => store.list()),
    comments: procedure.input(idInput).query(async ({ input }) => {
      const review = await store.read(input.id);
      return { comments: review.comments, github: review.github, directory: store.prDirectory(review) };
    }),
    resolveComment: procedure.input(idInput.extend({ commentId: z.string().min(1), resolved: z.boolean() }))
      .mutation(async ({ input }) => {
        const review = await store.read(input.id);
        return review.comments.find(comment => comment.id === input.commentId)?.github
          ? sync.resolve(input.id, input.commentId, input.resolved)
          : store.resolveComment(input.id, input.commentId, input.resolved);
      }),
    reply: procedure.input(idInput.extend({ commentId: z.string().min(1), github: z.boolean().default(false), requestId: z.string().uuid().optional(), author: z.string().trim().min(1).max(100).default("Agent"), body: z.string().trim().min(1).max(50000) }))
      .mutation(({ input }) => input.github ? sync.reply(input.id, input.commentId, input.body, input.requestId) : store.reply(input.id, input.commentId, input.author, input.body)),
    syncGitHub: procedure.input(idInput.extend({ force: z.boolean().default(false) })).mutation(({ input }) => sync.sync(input.id, input.force)),
    linkGitHub: procedure.input(idInput.extend({ url: z.string().max(2048) })).mutation(({ input }) => sync.link(input.id, input.url)),
    previewGitHubReview: procedure.input(idInput).query(({ input }) => sync.preview(input.id)),
    submitReview: procedure.input(idInput.extend({ requestId: z.string().uuid(), event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]), body: z.string().max(50000) })).mutation(({ input }) => sync.submit(input.id, input.event, input.body, input.requestId)),
    clearUncertainSubmission: procedure.input(idInput).mutation(({ input }) => sync.clearUncertain(input.id)),
    myPulls: procedure.input(scoped.optional()).query(({ input }) => {
      const repo = checkoutRepo(input?.checkout);
      return input?.checkout ? listCheckoutPulls(repo, currentBranch(repo)) : listMyPulls(undefined, repo);
    }),
    // File filters of the checkout's repository (see server/filters.ts).
    filters: procedure.input(scoped.optional()).query(({ input }) => readFilters(store.root, checkoutRepo(input?.checkout))),
    saveFilters: procedure
      .input(scoped.extend({ filters: z.array(z.object({
        name: z.string().trim().min(1).max(80),
        patterns: z.array(z.string().max(500)).max(200),
        enabled: z.boolean(),
      })).max(50) }))
      .mutation(({ input }) => writeFilters(store.root, checkoutRepo(input.checkout), input.filters)),
    repository: procedure.input(scoped.optional()).query(({ input }) => githubRepo(checkoutRepo(input?.checkout)).slug),
    // What a checkout (e.g. a T3 thread's worktree) is working on: its
    // repository, branch, and the open PR for that branch if there is one.
    checkout: procedure.input(z.object({ path: z.string().min(1).max(4096) })).query(async ({ input }) => {
      const repo = checkoutRepo(input.path);
      const github = githubRepoOrNull(repo);
      const branch = currentBranch(repo);
      // A failed lookup (gh signed in to an account without access, offline)
      // must not hide the checkout: the branch's commits still open.
      let pull = null;
      let pullError: string | null = null;
      if (github && branch) {
        try {
          pull = await pullForBranch(github.slug, branch);
        } catch (error) {
          pullError = error instanceof Error ? error.message : String(error);
        }
      }
      return { repo, repository: github?.slug ?? null, branch, pull, pullError };
    }),
    open: procedure
      .input(scoped.extend({ url: z.string().max(2048) }))
      .mutation(async ({ input }) => {
        const fresh = await loadLocalReview(
          await localPullMetadata(input.url, undefined, checkoutRepo(input.checkout)),
          store,
          checkoutRepo(input.checkout),
        );
        return store.transaction(async () => {
          let review = fresh;
          try {
            review = await store.read(fresh.id);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          return store.save({ ...review, title: fresh.title, source: fresh.source, generatedFiles: fresh.generatedFiles });
        });
      }),
    get: procedure
      .input(idInput)
      .query(({ input }) =>
        store.transaction(async () => {
          const review = await store.read(input.id);
          return store.save(review.generatedFiles === undefined ? await withGeneratedFiles(review) : review);
        }),
      ),
    fileContext: procedure
      .input(idInput.extend({ file: z.string().min(1).max(4096) }))
      .query(async ({ input }) => {
        const review = await store.read(input.id);
        const file = parseFiles(review.patch).find(
          (file) => file.name === input.file,
        );
        if (!file) throw new Error("This file is not part of the review.");
        return loadContext(store.path(input.id), review, file);
      }),
    saveComment: procedure.input(commentInput).mutation(async ({ input }) => {
      const current = await store.read(input.id);
      const remote = current.comments.find(comment => comment.id === input.commentId)?.github;
      if (remote) {
        if (input.expectedBody === undefined) throw new Error("Reload the comment before editing it.");
        return sync.edit(input.id, input.commentId!, input.body, input.expectedBody);
      }
      return store.update(input.id, async (review) => {
        const existing = input.commentId
          ? review.comments.find((comment) => comment.id === input.commentId)
          : undefined;
        if (input.commentId && !existing)
          throw new Error("This comment no longer exists. Reload the review.");
        const { code } = await selectedLines(review, input);
        const comment = {
          destination: input.destination ?? existing?.destination ?? "local",
          id: existing?.id ?? randomUUID(),
          snapshotId: existing?.snapshotId ?? review.id,
          file: input.file,
          side: input.side,
          start: input.start,
          end: input.end,
          body: input.body,
          code,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
        };
        if (existing)
          review.comments = review.comments.map((item) =>
            item.id === existing.id ? comment : item,
          );
        else review.comments.push(comment);
      });
    }),
    deleteComment: procedure
      .input(idInput.extend({ commentId: z.string().min(1) }))
      .mutation(({ input }) =>
        store.update(input.id, (review) => {
          if (review.comments.find(comment => comment.id === input.commentId)?.github) throw new Error("Delete published comments on GitHub; their local history will be retained.");
          review.comments = review.comments.filter(
            (comment) => comment.id !== input.commentId,
          );
        }),
      ),
    viewed: procedure
      .input(idInput.extend({ file: z.string(), viewed: z.boolean() }))
      .mutation(({ input }) =>
        store.update(input.id, (review) => {
          if (
            !parseFiles(review.patch).some((file) => file.name === input.file)
          )
            throw new Error("Unknown file.");
          review.viewed = review.viewed.filter((file) => file !== input.file);
          if (input.viewed) review.viewed.push(input.file);
        }),
      ),
    export: procedure.input(idInput).query(async ({ input }) => {
      const review = await store.read(input.id);
      return {
        markdown: markdown(review),
        path: join(review.source.kind === "local" && review.source.branchReview ? store.prDirectory(review) : store.path(input.id), "review.md"),
      };
    }),
  });
}

const fence = (text: string) => "~~~~\n" + text + "\n~~~~";
const where = (review: Review, comment: Comment) =>
  `${comment.file}, ${comment.side === "deletions" ? "old" : "new"} lines ${comment.start}-${comment.end}, in the review "${review.title}"`;
const replyInstruction = (review: Review, comment: Comment) => [
  "Answer in pr-review so it appears under those lines: POST your reply as JSON (keep it short and specific). The reply is rendered as Markdown: short paragraphs, lists, `backticks` for identifiers and paths, fenced code blocks. Do not change code unless asked.",
  fence(`curl -sS -X POST ${apiUrl}/trpc/reply -H 'Content-Type: application/json' --data-binary @- <<'JSON'
${JSON.stringify({ id: review.id, commentId: comment.id, author: "Agent", body: "YOUR ANSWER" })}
JSON`),
];
/** The first question in `comment`, with the lines and the diff around them. */
export function askMessage(review: Review, comment: Comment, hunks: string) {
  const lines = hunks.split("\n");
  return [
    `Question from pr-review about ${where(review, comment)}:`,
    "",
    comment.body,
    "",
    "The lines:",
    fence(comment.code),
    ...(hunks ? ["", "The diff around them:", fence(lines.length > 200 ? [...lines.slice(0, 200), `… ${lines.length - 200} more lines, see the file`].join("\n") : hunks)] : []),
    "",
    ...replyInstruction(review, comment),
  ].join("\n");
}
/** A follow-up `body` on an asked comment. The thread already has the question and its answers, so only a pointer to the full conversation in `directory` goes along. */
export function followUpMessage(review: Review, comment: Comment, body: string, directory: string) {
  return [
    `Follow-up from pr-review on ${where(review, comment)}. If you lost context, the full conversation is comment ${comment.id} in ${join(directory, "comments.json")}, with replies in ${join(directory, "replies.json")}.`,
    "",
    body.split("\n").map((line) => `> ${line}`).join("\n"),
    "",
    ...replyInstruction(review, comment),
  ].join("\n");
}

export type AppRouter = ReturnType<typeof createRouter>;
