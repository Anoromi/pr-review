import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import type { Review } from "../shared/types";
import { parseFiles } from "../shared/diff";
import { githubRepo, githubRepoOrNull, localRepo } from "./repository";

const execute = promisify(execFile);

export interface MyPullRequest {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  isCrossRepository: boolean;
  isDraft: boolean;
  updatedAt: string;
  /** Set on the open PR of the checkout's branch when someone else wrote it. */
  checkoutAuthor?: string;
}

let knownPulls: MyPullRequest[] = [];
export async function localPullMetadata(url: string, run = gh, repo = localRepo()) {
  const source = parsePullUrl(url);
  const configured = githubRepo(repo);
  if (source.owner !== configured.owner || source.repo !== configured.name)
    throw new Error(`Local review is configured for ${configured.slug}.`);
  const pull = knownPulls.find((pull) => pull.number === source.number && pull.url.includes(`/${source.owner}/${source.repo}/`));
  if (pull) return pull;
  return JSON.parse(await run([
    "pr", "view", String(source.number), "--repo", `${source.owner}/${source.repo}`,
    "--json", "number,title,url,headRefName,baseRefName,isCrossRepository,isDraft,updatedAt",
  ])) as MyPullRequest;
}

export async function listMyPulls(run = gh, repo = localRepo()): Promise<MyPullRequest[]> {
  const pulls: MyPullRequest[] = JSON.parse(
    await run([
      "pr",
      "list",
      "--repo",
      githubRepo(repo).slug,
      "--author",
      "@me",
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,url,headRefName,baseRefName,isCrossRepository,isDraft,updatedAt",
    ]),
  );
  knownPulls = pulls;
  return pulls.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function parsePullUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Paste a GitHub pull request URL.");
  }
  const match =
    /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?:\/(?:files|commits))?\/?$/.exec(
      url.pathname,
    );
  if (
    url.protocol !== "https:" ||
    !["github.com", "diffshub.com"].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    !match
  ) {
    throw new Error("Use https://github.com/owner/repository/pull/123.");
  }
  return {
    owner: match[1],
    repo: match[2],
    number: Number(match[3]),
    url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`,
  };
}

export async function gh(args: string[]) {
  try {
    const { stdout } = await execute("gh", args, {
      timeout: 60_000,
      maxBuffer: 30 * 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    });
    return stdout;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      stderr?: string;
      killed?: boolean;
    };
    if (failure.code === "ENOENT")
      throw new Error("Install GitHub CLI (gh), then run gh auth login.");
    if (failure.killed)
      throw new Error("GitHub took too long to respond. Try again.");
    if (failure.stderr?.includes("404"))
      throw new Error(
        "PR not found or access denied. Check the URL and your gh login.",
      );
    if (failure.stderr?.includes("403"))
      throw new Error(
        "GitHub denied access or rate limited this request. Check gh auth status and try later.",
      );
    throw new Error(
      "Could not load the PR. Check gh auth status, your network, and repository access.",
    );
  }
}

export async function loadPullRequest(
  value: string,
  findCached?: (
    url: string,
    head: string,
    base: string,
  ) => Promise<Review | undefined>,
  run = gh,
): Promise<Review> {
  const source = parsePullUrl(value);
  const endpoint = `repos/${source.owner}/${source.repo}/pulls/${source.number}`;
  const metadata = JSON.parse(await run(["api", endpoint])) as {
    title: string;
    head: { sha: string };
    base: { sha: string };
    changed_files: number;
  };
  const cached = await findCached?.(
    source.url,
    metadata.head.sha,
    metadata.base.sha,
  );
  if (cached)
    return {
      ...cached,
      title: `${source.owner}/${source.repo} #${source.number}: ${metadata.title}`,
    };
  const patch = await run([
    "api",
    endpoint,
    "-H",
    "Accept: application/vnd.github.diff",
  ]);
  const latest = JSON.parse(await run(["api", endpoint])) as typeof metadata;
  if (
    latest.head.sha !== metadata.head.sha ||
    latest.base.sha !== metadata.base.sha
  )
    throw new Error(
      "The PR changed while loading. Open it again to get a consistent revision.",
    );
  const files = parseFiles(patch);
  if (files.length !== metadata.changed_files)
    throw new Error(
      "GitHub returned an incomplete diff. This PR may be too large to load.",
    );
  const id = createHash("sha256")
    .update(
      `${source.url}\n${metadata.base.sha}\n${metadata.head.sha}\n${patch}`,
    )
    .digest("hex")
    .slice(0, 24);
  return {
    id,
    title: `${source.owner}/${source.repo} #${source.number}: ${metadata.title}`,
    source: { kind: "github", url: source.url },
    revision: metadata.head.sha,
    baseRevision: metadata.base.sha,
    patch,
    comments: [],
    viewed: [],
    updatedAt: new Date().toISOString(),
  };
}

/** The open PR whose head is `branch` in `slug` (any author), or null. */
export async function pullForBranch(slug: string, branch: string, run = gh): Promise<(MyPullRequest & { author: string }) | null> {
  const pulls: Array<MyPullRequest & { author?: { login?: string } }> = JSON.parse(await run([
    "pr", "list", "--repo", slug, "--head", branch, "--state", "open", "--limit", "1",
    "--json", "number,title,url,headRefName,baseRefName,isCrossRepository,isDraft,updatedAt,author",
  ]));
  const pull = pulls[0];
  return pull ? { ...pull, author: pull.author?.login ?? "" } : null;
}

/**
 * Your open PRs, plus the open PR of the checkout's branch when someone else
 * wrote it: a checkout of a teammate's branch should list the PR it opened.
 */
export async function listCheckoutPulls(repo: string, branch: string | null, run = gh): Promise<MyPullRequest[]> {
  const mine = await listMyPulls(run, repo);
  const slug = githubRepoOrNull(repo)?.slug;
  if (!slug || !branch || mine.some((pull) => pull.headRefName === branch)) return mine;
  const theirs = await pullForBranch(slug, branch, run).catch(() => null);
  if (!theirs) return mine;
  const { author, ...pull } = theirs;
  knownPulls = [...knownPulls, pull];
  return [{ ...pull, checkoutAuthor: author || "?" }, ...mine];
}
