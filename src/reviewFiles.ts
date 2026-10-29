import { parseFiles } from "../shared/diff";
import { chapterPatch } from "../shared/map";
import type { Review } from "../shared/types";
import type { FileDiffMetadata } from "@pierre/diffs";

// The diff renderer keys a file's layout and highlighting by its cacheKey and
// expects one object per key: a key must never stand for other content, and
// the same content must come back as the same object, not a new one under its key.
function lru(size: number) {
  const cache = new Map<string, FileDiffMetadata[]>();
  return (key: string, parse: () => FileDiffMetadata[]) => {
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const files = parse();
    cache.set(key, files);
    if (cache.size > size) cache.delete(cache.keys().next().value!);
    return files;
  };
}
const reviews = lru(6);
const chapters = lru(6);

export function reviewFiles(review: Pick<Review, "id" | "patch">) {
  return reviews(review.id, () => {
    const files = parseFiles(review.patch);
    files.forEach((file, index) => {
      file.cacheKey = `${review.id}:${index}`;
    });
    return files;
  });
}

let cuts = 0;
/**
 * The files of `review` (parsed as `files`) cut to the hunks `keys` names: a
 * chapter. Each new cut gets its own cacheKeys, since the same file cut to
 * other hunks is other content.
 */
export function chapterFiles(review: Pick<Review, "id" | "patch">, files: FileDiffMetadata[], keys: string[]) {
  return chapters(`${review.id}:${keys.join(",")}`, () => {
    const cut = parseFiles(chapterPatch(review.patch, files, new Set(keys)));
    const id = ++cuts;
    cut.forEach((file, index) => {
      file.cacheKey = `${review.id}:cut${id}:${index}`;
    });
    return cut;
  });
}
