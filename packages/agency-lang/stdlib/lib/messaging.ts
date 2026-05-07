/**
 * Shared recipient-checking logic for email, iMessage, and SMS.
 * Returns null if all recipients are allowed, or an error message string if any are blocked.
 */
export function checkRecipients(
  recipients: string[],
  allowList: string[],
  blockList: string[],
): string | null {
  if (allowList.length === 0 && blockList.length === 0) return null;

  const normalize = (s: string) => s.toLowerCase().trim();
  const normalizedAllow = allowList.map(normalize);
  const normalizedBlock = blockList.map(normalize);

  for (const r of recipients) {
    const nr = normalize(r);
    if (nr === "") continue;

    if (normalizedBlock.length > 0 && normalizedBlock.includes(nr)) {
      return `Recipient "${r}" is in the blockList.`;
    }

    if (normalizedAllow.length > 0 && !normalizedAllow.includes(nr)) {
      return `Recipient "${r}" is not in the allowList.`;
    }
  }

  return null;
}
