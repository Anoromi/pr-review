import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filteredFiles } from "../shared/filters";
import { filterKey, readFilters, writeFilters } from "./filters";

const files = [
  "apps/api/src/handler.rs",
  "apps/api/tests/handler.rs",
  "apps/web/src/form.tsx",
  "apps/web/src/form.test.tsx",
  "docs/tests.md",
  "tests/fixtures/sample.json",
];

test("enabled filters hide matching files with gitignore patterns", () => {
  const hidden = (patterns: string[], enabled = true) => [...filteredFiles(files, [{ name: "tests", patterns, enabled }])];
  assert.deepEqual(hidden(["tests/"]), ["apps/api/tests/handler.rs", "tests/fixtures/sample.json"]);
  assert.deepEqual(hidden(["/tests/"]), ["tests/fixtures/sample.json"]);
  assert.deepEqual(hidden(["*.test.tsx", "# a comment", "  "]), ["apps/web/src/form.test.tsx"]);
  // As in .gitignore: `!` re-includes a file a file pattern hid, but not one inside a hidden directory.
  assert.deepEqual(hidden(["*.rs", "!apps/api/src/handler.rs"]), ["apps/api/tests/handler.rs"]);
  assert.deepEqual(hidden(["tests/", "!apps/api/tests/handler.rs"]), ["apps/api/tests/handler.rs", "tests/fixtures/sample.json"]);
  assert.deepEqual(hidden(["tests/"], false), []);
  assert.deepEqual(hidden([]), []);
});

test("several filters add up", () => {
  const hidden = filteredFiles(files, [
    { name: "tests", patterns: ["*.test.tsx"], enabled: true },
    { name: "docs", patterns: ["docs/"], enabled: true },
    { name: "off", patterns: ["*.rs"], enabled: false },
  ]);
  assert.deepEqual([...hidden].sort(), ["apps/web/src/form.test.tsx", "docs/tests.md"]);
});

test("filters are saved per repository and shared by its checkouts", async () => {
  const root = mkdtempSync(join(tmpdir(), "pr-review-filters-"));
  const repo = (name: string, remote?: string) => {
    const path = join(root, name);
    execFileSync("git", ["init", "-q", path]);
    if (remote) execFileSync("git", ["-C", path, "remote", "add", "origin", remote]);
    return path;
  };
  const first = repo("first", "https://github.com/acme/widgets.git");
  const second = repo("second", "git@github.com:acme/widgets.git");
  const other = repo("other");
  assert.equal(filterKey(first), "acme/widgets");
  assert.equal(filterKey(other), other);
  assert.deepEqual(await readFilters(root, first), []);
  const filters = [{ name: "tests", patterns: ["tests/"], enabled: true }];
  await writeFilters(root, first, filters);
  assert.deepEqual(await readFilters(root, second), filters);
  assert.deepEqual(await readFilters(root, other), []);
});
