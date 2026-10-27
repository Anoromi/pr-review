import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Review } from "../shared/types";

// Code navigation inside a review: search the repository and read whole
// files at the reviewed head, both from Git so the checkout is never touched.

const execute = promisify(execFile);

function checkout(review: Review) {
  if (review.source.kind !== "local") throw new Error("Only reviews of a local checkout can search the repository.");
  return review.source.repo;
}

/** Lines at the review's head containing `word` as a whole word, at most `limit`. */
export async function grep(review: Review, word: string, limit = 300) {
  let output: string;
  try {
    output = (await execute("git", ["-C", checkout(review), "grep", "-n", "-I", "-F", "-w", "--no-color", "-e", word, review.revision, "--"], { maxBuffer: 60 * 1024 * 1024, timeout: 30_000 })).stdout;
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    // git grep exits with 1 when nothing matches.
    if (failure.code === 1 && !failure.stderr) return { matches: [], more: false };
    throw new Error(failure.stderr?.trim() || "git grep failed.");
  }
  const prefix = `${review.revision}:`;
  const rows = output.split("\n").filter(Boolean);
  const matches = rows.slice(0, limit).map((row) => {
    const rest = row.startsWith(prefix) ? row.slice(prefix.length) : row;
    const [, file, line, text] = /^(.*?):(\d+):(.*)$/.exec(rest) ?? [];
    if (!file) throw new Error(`Unexpected git grep output: ${row.slice(0, 200)}`);
    return { file, line: Number(line), text: text.slice(0, 400) };
  });
  return { matches, more: rows.length > limit };
}

/** `file` as it is at the review's head. */
export async function fileAt(review: Review, file: string) {
  try {
    return (await execute("git", ["-C", checkout(review), "show", `${review.revision}:${file}`], { maxBuffer: 60 * 1024 * 1024, timeout: 30_000 })).stdout;
  } catch (error) {
    throw new Error((error as { stderr?: string }).stderr?.trim() || `Cannot read ${file}.`);
  }
}
