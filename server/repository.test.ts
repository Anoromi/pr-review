import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutRepo, currentBranch, githubRepoOrNull, parseGitHubRemote } from "./repository";
import { listCheckoutPulls, pullForBranch } from "./github";

test("GitHub remotes parse in every form, including SSH host aliases", () => {
  const slug = (url: string, resolve?: (host: string) => string) => parseGitHubRemote(url, resolve)?.slug ?? null;
  assert.equal(slug("https://github.com/acme/widgets"), "acme/widgets");
  assert.equal(slug("https://github.com/acme/widgets.git"), "acme/widgets");
  assert.equal(slug("git@github.com:acme/widgets.git"), "acme/widgets");
  assert.equal(slug("ssh://git@github.com/acme/widgets"), "acme/widgets");
  assert.equal(slug("git@github-personal:acme/widgets.git", (host) => (host === "github-personal" ? "github.com" : host)), "acme/widgets");
  assert.equal(slug("git@gitlab.com:acme/widgets.git"), null);
  assert.equal(slug("/srv/git/widgets"), null);
});

test("a checkout path resolves to its repository, branch and GitHub remote", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pr-review-checkout-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "feature/thing");
  git("remote", "add", "origin", "git@github.com:acme/widgets.git");
  mkdirSync(join(root, "deep", "dir"), { recursive: true });
  assert.equal(checkoutRepo(join(root, "deep", "dir")), root);
  assert.equal(currentBranch(root), "feature/thing");
  assert.equal(githubRepoOrNull(root)?.slug, "acme/widgets");
  assert.throws(() => checkoutRepo("relative/path"));
  assert.throws(() => checkoutRepo(tmpdir()));
});

test("the PR for a branch is looked up by head in the checkout's repository", async () => {
  let command: string[] = [];
  const pull = await pullForBranch("acme/widgets", "feature/thing", async (args) => {
    command = args;
    return JSON.stringify([{ number: 7, title: "Thing", url: "https://github.com/acme/widgets/pull/7", headRefName: "feature/thing", baseRefName: "main", isCrossRepository: false, isDraft: false, updatedAt: "2026-01-01T00:00:00Z" }]);
  });
  assert.equal(pull?.number, 7);
  assert.deepEqual(command.slice(0, 6), ["pr", "list", "--repo", "acme/widgets", "--head", "feature/thing"]);
  assert.equal(await pullForBranch("acme/widgets", "none", async () => "[]"), null);
});

test("a checkout of someone else's branch lists that PR first, marked with its author", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pr-review-theirs-"));
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/acme/widgets.git"]);
  const row = (number: number, head: string, extra = {}) => ({ number, title: `PR ${number}`, url: `https://github.com/acme/widgets/pull/${number}`, headRefName: head, baseRefName: "main", isCrossRepository: false, isDraft: false, updatedAt: "2026-01-01T00:00:00Z", ...extra });
  const run = async (args: string[]) => JSON.stringify(args.includes("@me") ? [row(1, "mine")] : [row(9, "rj/thing", { author: { login: "rj" } })]);
  const pulls = await listCheckoutPulls(repo, "rj/thing", run);
  assert.deepEqual(pulls.map((pull) => [pull.number, pull.checkoutAuthor]), [[9, "rj"], [1, undefined]]);
  assert.deepEqual((await listCheckoutPulls(repo, "mine", run)).map((pull) => pull.number), [1]);
});
