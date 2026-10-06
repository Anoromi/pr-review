import { parseFiles } from "../shared/diff";
import type { Review } from "../shared/types";
import type { FileDiffMetadata } from "@pierre/diffs";

const cache = new Map<string, FileDiffMetadata[]>();

export function reviewFiles(review: Pick<Review, "id" | "patch">) {
  const cached = cache.get(review.id);
  if (cached) {
    cache.delete(review.id);
    cache.set(review.id, cached);
    return cached;
  }
  const files = parseFiles(review.patch);
  files.forEach((file, index) => {
    file.cacheKey = `${review.id}:${index}`;
  });
  cache.set(review.id, files);
  if (cache.size > 6) cache.delete(cache.keys().next().value!);
  return files;
}
