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
import { localPullMetadata, listCheckoutPulls, listMyPulls, pullForBranch } from "./github";
import { checkoutRepo, currentBranch, githubRepo, githubRepoOrNull } from "./repository";
import { markdown } from "./markdown";
import { parseFiles, selectedCode } from "../shared/diff";

const t = initTRPC.create();
const idInput = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) });
// Which checkout a request works on (see checkoutRepo); omitted = the default.
const scoped = z.object({ checkout: z.string().min(1).max(4096).optional() });
const commentInput = idInput
  .extend({
    commentId: z.string().min(1).optional(),
    destination: z.enum(["local", "github"]).optional(),
    expectedBody: z.string().optional(),
    file: z.string().min(1).max(4096),
    side: z.enum(["additions", "deletions"]),
    start: z.number().int().positive(),
    end: z.number().int().positive(),
    body: z.string().trim().min(1).max(50_000),
  })
  .refine(
    (input) => input.end >= input.start && input.end - input.start < 500,
    "Select between 1 and 500 lines.",
  );

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
  return t.router({
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
        const file = parseFiles(review.patch).find(
          (file) => file.name === input.file,
        );
        if (!file) throw new Error("This file is not part of the review.");
        const context = await readContext(store.path(input.id), file.name);
        if (context) hydratePartialDiff("merge", file, context);
        const code = selectedCode(file, input.side, input.start, input.end);
        const existing = input.commentId
          ? review.comments.find((comment) => comment.id === input.commentId)
          : undefined;
        if (input.commentId && !existing)
          throw new Error("This comment no longer exists. Reload the review.");
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

export type AppRouter = ReturnType<typeof createRouter>;
