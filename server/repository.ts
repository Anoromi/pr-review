import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

/** The local checkout reviews are computed from. */
export const localRepo = () => resolve(process.env.LOCAL_REPO ?? process.cwd());

export interface GitHubRepository {
  owner: string;
  name: string;
  slug: string;
}

/**
 * `owner/name` from a GitHub remote URL (HTTPS, SSH or scp-like), or null.
 * `resolveHost` maps an SSH host alias (e.g. `github-personal` in
 * ~/.ssh/config) to the real host name.
 */
export function parseGitHubRemote(url: string, resolveHost: (host: string) => string = (host) => host): GitHubRepository | null {
  const match =
    /^https:\/\/(?:[^@/]+@)?([^/:]+)\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim()) ??
    /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim()) ??
    /^(?:[^@/\s]+@)?([^/:\s]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!match) return null;
  const [, host, owner, name] = match;
  if (host !== "github.com" && resolveHost(host) !== "github.com") return null;
  return { owner, name, slug: `${owner}/${name}` };
}

/** The host an SSH alias connects to, per `ssh -G`; the alias itself if unknown. */
export function sshHostName(alias: string): string {
  try {
    const config = execFileSync("ssh", ["-G", alias], { encoding: "utf8", timeout: 5000 });
    return /^hostname (\S+)$/m.exec(config)?.[1] ?? alias;
  } catch {
    return alias;
  }
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
  const parsed = parseGitHubRemote(remote, sshHostName);
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

/**
 * The repository a request works on: the top level of `checkout` (a path to
 * any directory inside a Git checkout or worktree) when given, otherwise the
 * default checkout.
 */
export function checkoutRepo(checkout?: string): string {
  if (!checkout) return localRepo();
  if (!isAbsolute(checkout)) throw new Error("The checkout must be an absolute path.");
  try {
    return execFileSync("git", ["-C", checkout, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(`${checkout} is not inside a Git checkout.`);
  }
}

/** The branch checked out in `repo`, or null when HEAD is detached. */
export function currentBranch(repo: string): string | null {
  try {
    return execFileSync("git", ["-C", repo, "symbolic-ref", "--short", "-q", "HEAD"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}
