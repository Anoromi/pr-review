import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/** The local checkout reviews are computed from. */
export const localRepo = () => resolve(process.env.LOCAL_REPO ?? process.cwd());

export interface GitHubRepository {
  owner: string;
  name: string;
  slug: string;
}

/** `owner/name` from a GitHub remote URL (SSH, scp-like or HTTPS), or null. */
export function parseGitHubRemote(url: string): GitHubRepository | null {
  const match = /^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? { owner: match[1], name: match[2], slug: `${match[1]}/${match[2]}` } : null;
}

const cache = new Map<string, GitHubRepository>();

/**
 * The GitHub repository whose pull requests are reviewed: `GITHUB_REPO`
 * (`owner/name`) when set, otherwise the local checkout's `origin` remote.
 */
export function githubRepo(repo = localRepo()): GitHubRepository {
  const configured = process.env.GITHUB_REPO?.trim();
  if (configured) {
    const [owner, name, ...rest] = configured.split("/");
    if (!owner || !name || rest.length) throw new Error("GITHUB_REPO must look like owner/name.");
    return { owner, name, slug: `${owner}/${name}` };
  }
  repo = resolve(repo);
  const known = cache.get(repo);
  if (known) return known;
  let remote = "";
  try {
    remote = execFileSync("git", ["-C", repo, "config", "--get", "remote.origin.url"], { encoding: "utf8" });
  } catch {}
  const parsed = parseGitHubRemote(remote);
  if (!parsed) throw new Error(`Set GITHUB_REPO=owner/name: the origin remote of ${repo} is not a GitHub repository.`);
  cache.set(repo, parsed);
  return parsed;
}

/** Like {@link githubRepo}, but null when the checkout has no GitHub remote. */
export function githubRepoOrNull(repo = localRepo()): GitHubRepository | null {
  try {
    return githubRepo(repo);
  } catch {
    return null;
  }
}
