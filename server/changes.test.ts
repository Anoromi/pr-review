import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { agentChanges } from "./changes";
const exec = promisify(execFile);

// A scratch repository on `main` with a.txt and b.txt, and `checkpoint`,
// which snapshots the working tree as T3 Code does: a commit of the whole
// tree (untracked files too) through a temporary index, parented on HEAD.
async function scratch(run: (repo: { git: (...args: string[]) => Promise<string>; write: (file: string, text: string) => Promise<void>; checkpoint: () => Promise<string> }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "agent-changes-"));
  const git = async (...args: string[]) => (await exec("git", ["-C", dir, ...args], { env: { ...process.env, GIT_INDEX_FILE: undefined } })).stdout.trim();
  const write = (file: string, text: string) => writeFile(join(dir, file), text);
  async function checkpoint() {
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, ".git", "checkpoint-index") };
    const run = async (...args: string[]) => (await exec("git", ["-C", dir, ...args], { env })).stdout.trim();
    await run("read-tree", "HEAD");
    await run("add", "-A", "--", ".");
    const tree = await run("write-tree");
    return run("commit-tree", tree, "-p", "HEAD", "-m", "checkpoint");
  }
  try {
    await git("init", "-b", "main");
    await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.com");
    await write("a.txt", "one\ntwo\nthree\n"); await write("b.txt", "b\n");
    await git("add", "."); await git("commit", "-m", "base");
    await run({ git, write, checkpoint });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const changedFiles = (patch: string) => [...patch.matchAll(/^diff --git a\/(\S+)/gm)].map((match) => match[1]);

test("edits and commits since the start show; uncommitted edits from before it do not", () => scratch(async ({ git, write, checkpoint }) => {
  await write("b.txt", "b, edited by the user before the turn\n");
  const start = await checkpoint();
  await write("a.txt", "one\nTWO\nthree\n"); await git("commit", "-am", "agent commit");
  await write("new.txt", "untracked\n");
  const end = await checkpoint();
  const { patch } = await agentChanges(await git("rev-parse", "--show-toplevel"), start, end, "main");
  assert.deepEqual(changedFiles(patch), ["a.txt", "new.txt"]);
  assert.match(patch, /-two\n\+TWO/);
}));

test("a merge shows only its conflict resolution and the agent's edits, not the merged branch", () => scratch(async ({ git, write, checkpoint }) => {
  const repo = await git("rev-parse", "--show-toplevel");
  await git("checkout", "-b", "feature");
  await write("a.txt", "one\nfeature\nthree\n"); await git("commit", "-am", "feature");
  await git("checkout", "main");
  await write("a.txt", "one\nmain\nthree\n"); await write("b.txt", "b from main\n"); await git("commit", "-am", "main");
  await git("checkout", "feature");
  const start = await checkpoint();
  await git("merge", "main").catch(() => undefined);
  await write("a.txt", "one\nfeature and main\nthree\n"); await git("commit", "-am", "merge main");
  await write("c.txt", "agent\n");
  const end = await checkpoint();
  const { patch } = await agentChanges(repo, start, end, "main");
  assert.deepEqual(changedFiles(patch), ["a.txt", "c.txt"]);
  // The resolution replaces the conflict markers the automatic merge left.
  assert.match(patch, /^-<<<<<<< .*\n-feature\n(-\|\|\|\|\|\|\| .*\n-two\n)?-=======\n-main\n->>>>>>> .*\n\+feature and main$/m);
}));

test("a rebase onto a moved main shows the branch's own changes, not main's", () => scratch(async ({ git, write, checkpoint }) => {
  const repo = await git("rev-parse", "--show-toplevel");
  await git("checkout", "-b", "feature");
  await write("a.txt", "one\nfeature\nthree\n"); await git("commit", "-am", "feature");
  await git("checkout", "main");
  await write("b.txt", "b from main\n"); await git("commit", "-am", "main moved");
  await git("checkout", "feature");
  const start = await checkpoint();
  await git("rebase", "main");
  await write("a.txt", "one\nfeature, after the rebase\nthree\n");
  const end = await checkpoint();
  const { patch } = await agentChanges(repo, start, end, "main");
  assert.deepEqual(changedFiles(patch), ["a.txt"]);
  assert.match(patch, /-feature\n\+feature, after the rebase/);
}));

test("commits fast-forwarded from upstream do not show", () => scratch(async ({ git, write, checkpoint }) => {
  const repo = await git("rev-parse", "--show-toplevel");
  await git("branch", "upstream");
  await git("checkout", "upstream");
  await write("b.txt", "b upstream\n"); await git("commit", "-am", "upstream");
  await git("checkout", "main");
  const start = await checkpoint();
  await git("merge", "--ff-only", "upstream");
  await write("a.txt", "one\nagent\nthree\n"); await git("commit", "-am", "agent");
  const end = await checkpoint();
  const { patch } = await agentChanges(repo, start, end, "upstream");
  assert.deepEqual(changedFiles(patch), ["a.txt"]);
}));
