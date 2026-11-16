/** The oldest @agency-lang/mcp the agent's MCP support works with. 0.0.6 is
 *  the first version that can connect without starting a login. */
export const MIN_MCP_VERSION = "0.0.6";

/** The three dotted numbers at the start of a version, or null when it does
 *  not start with them. */
function versionNumbers(version: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match === null ? null : match.slice(1).map(Number);
}

/** True when `found` is `wanted` or newer. Compares the three dotted numbers
 *  and ignores any suffix after them. A string that is not a version is older
 *  than everything. */
export function versionAtLeast(found: string, wanted: string): boolean {
  const have = versionNumbers(found);
  const need = versionNumbers(wanted);
  if (have === null || need === null) {
    return false;
  }
  for (let i = 0; i < need.length; i++) {
    if (have[i] !== need[i]) {
      return have[i] > need[i];
    }
  }
  return true;
}

/** The text shown to the user, or "" when `found` is new enough. */
export function packageProblem(found: string): string {
  if (versionAtLeast(found, MIN_MCP_VERSION)) {
    return "";
  }
  return `@agency-lang/mcp ${found} is too old. Run: npm install -g @agency-lang/mcp@latest`;
}
