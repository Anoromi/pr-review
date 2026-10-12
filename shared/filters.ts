import ignore from "ignore";

/**
 * A named set of gitignore-style patterns. Files matching an enabled filter
 * are left out of a review: `tests/` hides every directory called tests,
 * `*.test.ts` every such file, `/docs/` only the top-level directory, and a
 * leading `!` keeps files an earlier file pattern would hide.
 */
export interface FileFilter {
  name: string;
  patterns: string[];
  enabled: boolean;
}

/** The files the enabled filters hide. Invalid patterns match nothing. */
export function filteredFiles(names: readonly string[], filters: readonly FileFilter[]): Set<string> {
  const hidden = new Set<string>();
  for (const filter of filters) {
    if (!filter.enabled) continue;
    const patterns = filter.patterns.map((pattern) => pattern.trim()).filter((pattern) => pattern && !pattern.startsWith("#"));
    if (!patterns.length) continue;
    const matcher = ignore().add(patterns);
    for (const name of names) {
      try {
        if (matcher.ignores(name)) hidden.add(name);
      } catch {
        /* A path the matcher rejects (absolute, empty) is never hidden. */
      }
    }
  }
  return hidden;
}
