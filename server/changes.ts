import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import type { Review } from "../shared/types";
import { loadSnapshot, upstreamRef } from "./branches";
import type { ReviewStore } from "./store";
import type { Turn } from "./t3";

const execute = promisify(execFile);
async function git(repo: string, ...args: string[]) {
  return (await execute("git", ["-C", repo, ...args], { maxBuffer: 60 * 1024 * 1024, timeout: 30000 })).stdout;
}
const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--full-index", "--src-prefix=a/", "--dst-prefix=b/"];

/**
 * `tree` with the changes from `from` to `to` merged in, as `git merge-tree`
 * does: a conflict leaves its markers in the file, so diffing the result
 * against what the agent committed shows how it resolved the conflict.
 */
async function mergeInto(repo: string, tree: string, from: string, to: string) {
  try {
    return (await git(repo, "merge-tree", "--write-tree", "--no-messages", `--merge-base=${from}`, tree, to)).split("\n")[0];
  } catch (error) {
    // Exit code 1: merged with conflicts; the tree is still the first line.
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    if (failure.code === 1 && failure.stdout) return failure.stdout.split("\n")[0];
    throw new Error(failure.stderr?.trim() || "git merge-tree failed.");
  }
}

/**
 * What the agent changed between two snapshots of a checkout, without what
 * merges and rebases brought in from other branches. A snapshot is a T3
 * Code checkpoint: a commit of the whole working tree (uncommitted and
 * untracked files included) whose parent is HEAD when it was taken.
 *
 * The patch compares `end` with `base`: the `start` tree with the other
 * branches' changes merged in the way the agent did it.
 * - Commits on top of HEAD and working-tree edits: a plain diff (`base` is `start`).
 * - A merge made in between: its other parents' changes are merged in, so
 *   only conflict resolutions and edits beyond the automatic merge show
 *   (`git show --remerge-diff`). Commits fast-forwarded from `upstream` are
 *   taken over the same way.
 * - A rebase (HEAD no longer descends from the start's HEAD): the move of the
 *   branch's base on `upstream` is merged in, so the branch's own changes
 *   before and after are compared (`git range-diff`).
 */
export async function agentChanges(repo: string, start: string, end: string, upstream: string) {
  const parent = async (commit: string) => (await git(repo, "rev-parse", "--verify", `${commit}^1`)).trim();
  const [startHead, endHead] = await Promise.all([parent(start), parent(end)]);
  let base = (await git(repo, "rev-parse", "--verify", `${start}^{tree}`)).trim();
  const descends = startHead === endHead || await git(repo, "merge-base", "--is-ancestor", startHead, endHead).then(() => true, () => false);
  if (!descends) {
    const [before, after] = await Promise.all([startHead, endHead].map(async (head) => (await git(repo, "merge-base", head, upstream)).trim()));
    if (before !== after) base = await mergeInto(repo, base, before, after);
  } else if (startHead !== endHead) {
    // The first-parent path from the start's HEAD, oldest first, and which
    // of its commits upstream lacks (the agent's own). When upstream already
    // has the end's HEAD (a checkout of upstream itself), all of them are.
    const path = (await git(repo, "rev-list", "--first-parent", "--parents", "--reverse", `${startHead}..${endHead}`)).trim().split("\n").map((line) => line.split(" "));
    const upstreamHas = await git(repo, "merge-base", "--is-ancestor", endHead, upstream).then(() => true, () => false);
    const own = new Set((await git(repo, "rev-list", endHead, "--not", startHead, ...(upstreamHas ? [] : [upstream]))).trim().split("\n"));
    // A run of commits taken from upstream is merged in as one range.
    let taken = null as { from: string; to: string } | null;
    for (const [commit, first, ...others] of path) {
      const foreign = !others.length && !own.has(commit);
      if (foreign) { taken = { from: taken?.from ?? first, to: commit }; continue; }
      if (taken) { base = await mergeInto(repo, base, taken.from, taken.to); taken = null; }
      for (const other of others) base = await mergeInto(repo, base, (await git(repo, "merge-base", first, other)).trim(), other);
    }
    if (taken) base = await mergeInto(repo, base, taken.from, taken.to);
  }
  return { base, patch: await git(repo, ...diffArgs, base, end, "--") };
}

/**
 * The thread's own changes in `turns` (those since the last one reviewed,
 * oldest first) as a snapshot sharing `parent`'s conversation folder: from
 * before the first turn to after the last that finished with a snapshot.
 * Null while none has.
 */
export async function loadChanges(parent: Review, threadId: string, turns: Turn[], store: ReviewStore): Promise<Review | null> {
  if (parent.source.kind !== "local") throw new Error("Only reviews of a local checkout have agent changes.");
  const last = turns.findLast((turn) => turn.end);
  if (!last) return null;
  const first = turns[0];
  if (!first.start) throw new Error(`T3 Code has no snapshot of the checkout from before turn ${first.ordinal}, so its changes cannot be shown.`);
  const { repo, url } = parent.source;
  const resolve = (ref: string, when: string) => git(repo, "rev-parse", "--verify", `${ref}^{commit}`).then((sha) => sha.trim(), () => {
    throw new Error(`The snapshot from ${when} (${ref}) is missing from ${repo}.`);
  });
  const [start, end] = await Promise.all([resolve(first.start, `before turn ${first.ordinal}`), resolve(last.end!, `after turn ${last.ordinal}`)]);
  const { base, patch } = await agentChanges(repo, start, end, await upstreamRef(parent));
  const id = createHash("sha256").update(JSON.stringify([repo, url, "changes", threadId, start, end, base])).digest("hex").slice(0, 24);
  const source = { ...parent.source, changes: { threadId, from: first.ordinal, to: last.ordinal } };
  const turnsTitle = first.ordinal === last.ordinal ? `turn ${first.ordinal}` : `turns ${first.ordinal}–${last.ordinal}`;
  return loadSnapshot(repo, id, `${parent.title}: ${turnsTitle}`, source, end, base, store, patch);
}
