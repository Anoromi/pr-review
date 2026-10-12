import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { FileFilter } from "../shared/filters";
import { githubRepoOrNull } from "./repository";

/**
 * File filters belong to a repository, not to one review or checkout: every
 * worktree of a GitHub repository shares them, and a repository without a
 * GitHub remote is keyed by its path. They live in the review store, outside
 * the reviewed repository.
 */
export function filterKey(repo: string) {
  return githubRepoOrNull(repo)?.slug ?? repo;
}

function filterFile(root: string, repo: string) {
  const key = createHash("sha256").update(filterKey(repo)).digest("hex").slice(0, 24);
  return join(root, "filters", `${key}.json`);
}

export async function readFilters(root: string, repo: string): Promise<FileFilter[]> {
  try {
    const saved = JSON.parse(await readFile(filterFile(root, repo), "utf8"));
    return Array.isArray(saved.filters) ? saved.filters : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
}

export async function writeFilters(root: string, repo: string, filters: FileFilter[]): Promise<FileFilter[]> {
  const file = filterFile(root, repo);
  await mkdir(join(root, "filters"), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ repository: filterKey(repo), filters }, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, file);
  return filters;
}
