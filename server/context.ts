import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { FileDiffMetadata, FileDiffLoadedFiles } from "@pierre/diffs";
import type { Review } from "../shared/types";
import { gh, parsePullUrl } from "./github";

function cachePath(directory: string, file: string) {
  return join(
    directory,
    `context-${createHash("sha256").update(file).digest("hex")}.json`,
  );
}

export async function readContext(
  directory: string,
  file: string,
): Promise<FileDiffLoadedFiles | undefined> {
  try {
    return JSON.parse(await readFile(cachePath(directory, file), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export async function loadContext(
  directory: string,
  review: Review,
  file: FileDiffMetadata,
  run = gh,
): Promise<FileDiffLoadedFiles> {
  const cached = await readContext(directory, file.name);
  if (cached) return cached;
  if (review.source.kind === "local")
    throw new Error(
      "Local context is missing from this snapshot. Reload the local diff.",
    );
  const { owner, repo } = parsePullUrl(review.source.url);
  const endpoint = `repos/${owner}/${repo}`;
  const comparison = JSON.parse(
    await run([
      "api",
      `${endpoint}/compare/${review.baseRevision}...${review.revision}`,
    ]),
  );
  const base = comparison.merge_base_commit?.sha;
  if (!/^[a-f0-9]{40}$/.test(base ?? ""))
    throw new Error("Could not resolve the diff's base commit.");
  async function content(name: string, revision: string, objectId?: string) {
    if (objectId && /^0+$/.test(objectId)) return { name, contents: "" };
    const path = name.split("/").map(encodeURIComponent).join("/");
    const contents = await run([
      "api",
      `${endpoint}/contents/${path}?ref=${revision}`,
      "-H",
      "Accept: application/vnd.github.raw",
    ]);
    const hash = createHash("sha1")
      .update(`blob ${Buffer.byteLength(contents)}\0`)
      .update(contents)
      .digest("hex");
    if (!objectId || !hash.startsWith(objectId))
      throw new Error("File contents do not match the cached diff.");
    return { name, contents, cacheKey: hash };
  }
  const [oldFile, newFile] = await Promise.all([
    content(file.prevName ?? file.name, base, file.prevObjectId),
    content(file.name, review.revision, file.newObjectId),
  ]);
  const result = {
    oldFile: file.type === "rename-pure" ? null : oldFile,
    newFile,
  };
  await writeContext(directory, file.name, result);
  return result;
}

export async function writeContext(
  directory: string,
  file: string,
  result: FileDiffLoadedFiles,
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = cachePath(directory, file);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(result), { mode: 0o600 });
  await rename(temporary, destination);
  return result;
}
