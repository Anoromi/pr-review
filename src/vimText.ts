export type TextPosition = { line: number; column: number };

export function orderedPositions(a: TextPosition, b: TextPosition) {
  return a.line < b.line || (a.line === b.line && a.column <= b.column) ? [a, b] : [b, a];
}

export function selectedCharacters(text: string, a: TextPosition, b: TextPosition) {
  const [start, end] = orderedPositions(a, b);
  const lines = text.split("\n");
  const first = Math.min(start.column, Math.max(0, lines[0].length - 1));
  const last = Math.min(end.column + 1, lines[lines.length - 1].length);
  if (lines.length === 1) return lines[0].slice(first, last);
  lines[lines.length - 1] = lines[lines.length - 1].slice(0, last);
  lines[0] = lines[0].slice(first);
  return lines.join("\n");
}

export function wordColumn(text: string, column: number, direction: 1 | -1, big: boolean): number | null {
  const group = (index: number) => /\s/.test(text[index]) ? 0 : big || /[\p{L}\p{N}_]/u.test(text[index]) ? 1 : 2;
  let index = column;
  if (direction === 1) {
    if (index >= text.length) return null;
    const current = group(index);
    while (index < text.length && group(index) === current) index++;
    while (index < text.length && group(index) === 0) index++;
    return index < text.length ? index : null;
  }
  index = Math.min(column - 1, text.length - 1);
  while (index >= 0 && group(index) === 0) index--;
  if (index < 0) return null;
  const current = group(index);
  while (index > 0 && group(index - 1) === current) index--;
  return index;
}
