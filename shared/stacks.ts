interface StackPull {
  number: number;
  headRefName: string;
  baseRefName: string;
  isCrossRepository: boolean;
  updatedAt: string;
}

export function orderStacks<T extends StackPull>(
  pulls: T[],
): Array<{ pull: T; depth: number; parent?: number }> {
  const byNumber = new Map(pulls.map((pull) => [pull.number, pull]));
  const heads = Map.groupBy(
    pulls.filter((pull) => !pull.isCrossRepository),
    (pull) => pull.headRefName,
  );
  const parents = new Map<number, number>();
  for (const pull of pulls) {
    const candidates = heads.get(pull.baseRefName);
    if (candidates?.length === 1 && candidates[0].number !== pull.number)
      parents.set(pull.number, candidates[0].number);
  }
  // Malformed or temporarily cyclic branch relationships must not hide PRs.
  for (const pull of pulls) {
    const path: number[] = [];
    let number: number | undefined = pull.number;
    while (number !== undefined) {
      const cycle = path.indexOf(number);
      if (cycle !== -1) {
        parents.delete(Math.min(...path.slice(cycle)));
        break;
      }
      path.push(number);
      number = parents.get(number);
    }
  }
  const children = Map.groupBy(
    pulls.filter((pull) => parents.has(pull.number)),
    (pull) => parents.get(pull.number)!,
  );
  const latest = (pull: T): string =>
    (children.get(pull.number) ?? []).reduce((date, child) => {
      const updated = latest(child);
      return updated > date ? updated : date;
    }, pull.updatedAt);
  const roots = pulls
    .filter((pull) => !parents.has(pull.number))
    .sort((a, b) => latest(b).localeCompare(latest(a)) || a.number - b.number);
  const ordered: Array<{ pull: T; depth: number; parent?: number }> = [];
  function visit(pull: T, depth: number) {
    ordered.push({ pull, depth, parent: parents.get(pull.number) });
    for (const child of (children.get(pull.number) ?? []).sort(
      (a, b) => a.number - b.number,
    ))
      visit(byNumber.get(child.number)!, depth + 1);
  }
  for (const root of roots) visit(root, 0);
  return ordered;
}
