/** JSON-stringify a value and cap its length for log/error previews.
 *  Leaf module on purpose: imported by both ipc.ts and
 *  failurePropagation.ts, which must not pull in each other's graphs
 *  (ipc.ts loads the subprocess machinery; failurePropagation.ts sits on
 *  the hot path of every call via agencyFunction.ts). */
export function truncate(val: any, maxLen = 200): string {
  let s: string | undefined;
  if (typeof val === "string") {
    s = val;
  } else {
    // JSON.stringify throws on BigInt and circular structures. This runs
    // inside error/warn reporting paths, where a throw would mask the
    // signal being reported — fall back to String() instead.
    try {
      s = JSON.stringify(val);
    } catch {
      s = String(val);
    }
  }
  if (s == null) {
    return "undefined";
  }
  return s.length > maxLen ? s.slice(0, maxLen) + "..." : s;
}
