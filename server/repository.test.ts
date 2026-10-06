import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutRepo, currentBranch, githubRepoOrNull, parseGitHubRemote } from "./repository";
import { pullForBranch } from "./github";

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
