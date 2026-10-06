import { test } from "node:test";
import assert from "node:assert/strict";
import { orderStacks } from "../shared/stacks";

const pull = (
  number: number,
  headRefName: string,
  baseRefName = "main",
  updatedAt = "2026-09-01",
  isCrossRepository = false,
) => ({ number, headRefName, baseRefName, updatedAt, isCrossRepository });

test("orders complete stacks parent-first with deterministic sibling order and latest stack activity", () => {
  const result = orderStacks([
    pull(5, "tip", "child", "2026-09-08"),
    pull(9, "independent", "main", "2026-09-07"),
    pull(4, "sibling", "root"),
    pull(2, "child", "root"),
    pull(1, "root"),
  ]);
  assert.deepEqual(
    result.map(({ pull, depth, parent }) => [pull.number, depth, parent]),
    [
      [1, 0, undefined],
      [2, 1, 1],
      [5, 2, 2],
      [4, 1, 1],
      [9, 0, undefined],
    ],
  );
});

test("missing or ambiguous parents and fork head names do not create false dependencies", () => {
  const result = orderStacks([
    pull(1, "duplicate"),
    pull(2, "duplicate"),
    pull(3, "child", "duplicate"),
    pull(4, "fork", "main", "2026-09-01", true),
    pull(5, "other", "fork"),
    pull(6, "orphan", "merged-parent"),
  ]);
  assert.ok(
    result.every((entry) => entry.depth === 0 && entry.parent === undefined),
  );
  assert.equal(result.length, 6);
});

test("cycles and self references preserve each PR once, with deterministic cycle breaking", () => {
  const result = orderStacks([
    pull(3, "c", "b"),
    pull(2, "b", "a"),
    pull(1, "a", "c"),
    pull(4, "self", "self"),
  ]);
  assert.deepEqual(
    result.map(({ pull }) => pull.number),
    [1, 2, 3, 4],
  );
  assert.equal(new Set(result.map(({ pull }) => pull.number)).size, 4);
  assert.deepEqual(orderStacks([]), []);
});
