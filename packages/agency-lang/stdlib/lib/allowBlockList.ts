/**
 * Check values against an allow list and/or block list.
 * Returns null if all values pass, or an error message string if any are rejected.
 * Comparison is case-insensitive and whitespace-trimmed.
 */
export function checkAllowBlockList(
  values: string[],
  allowList: string[],
  blockList: string[],
): string | null {
  if (allowList.length === 0 && blockList.length === 0) return null;

  const normalize = (s: string) => s.toLowerCase().trim();
  const normalizedAllow = allowList.map(normalize);
  const normalizedBlock = blockList.map(normalize);

  for (const v of values) {
    const nv = normalize(v);
    if (nv === "") continue;

    if (normalizedBlock.length > 0 && normalizedBlock.includes(nv)) {
      return `"${v}" is in the blockList.`;
    }

    if (normalizedAllow.length > 0 && !normalizedAllow.includes(nv)) {
      return `"${v}" is not in the allowList.`;
    }
  }

  return null;
}
