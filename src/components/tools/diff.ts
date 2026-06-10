export type DiffLine = {
  kind: 'add' | 'del' | 'keep' | 'gap';
  oldNo: number | null;
  newNo: number | null;
  text: string;
  /** For gap lines: how many unchanged lines were collapsed. */
  gapSize?: number;
};

export function lineDiff(prior: string, next: string): DiffLine[] {
  const a = prior.split('\n');
  const b = next.split('\n');
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ kind: 'keep', oldNo: i + 1, newNo: j + 1, text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', oldNo: i + 1, newNo: null, text: a[i] });
      i++;
    } else {
      out.push({ kind: 'add', oldNo: null, newNo: j + 1, text: b[j] });
      j++;
    }
  }
  while (i < m) out.push({ kind: 'del', oldNo: i + 1, newNo: null, text: a[i++] });
  while (j < n) out.push({ kind: 'add', oldNo: null, newNo: j + 1, text: b[j++] });
  return out;
}

/**
 * Trim down to ±context lines around any change, replacing larger unchanged
 * stretches with a single `gap` marker.
 */
export function withContext(lines: DiffLine[], context: number): DiffLine[] {
  if (context < 0) return lines;
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].kind !== 'keep') {
      const lo = Math.max(0, k - context);
      const hi = Math.min(lines.length - 1, k + context);
      for (let p = lo; p <= hi; p++) keep[p] = true;
    }
  }
  const out: DiffLine[] = [];
  let lastKept = -1;
  for (let k = 0; k < lines.length; k++) {
    if (!keep[k]) continue;
    if (lastKept >= 0 && k > lastKept + 1) {
      out.push({
        kind: 'gap',
        oldNo: null,
        newNo: null,
        text: '',
        gapSize: k - lastKept - 1,
      });
    }
    out.push(lines[k]);
    lastKept = k;
  }
  return out;
}

/** Replace the first occurrence (or all) of `oldStr` in `prior` with `newStr`. */
export function applyEdit(
  prior: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean,
): string {
  if (!oldStr) return prior;
  if (replaceAll) return prior.split(oldStr).join(newStr);
  const idx = prior.indexOf(oldStr);
  if (idx < 0) return prior;
  return prior.slice(0, idx) + newStr + prior.slice(idx + oldStr.length);
}
