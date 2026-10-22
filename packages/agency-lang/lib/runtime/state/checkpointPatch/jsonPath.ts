/** The value at `path` in a JSON tree, or undefined when any segment is
 *  missing. Array indices are their decimal strings, as the readers
 *  write them. */
export function getAt(json: unknown, path: string[]): unknown {
  let here: unknown = json;
  for (const segment of path) {
    if (here === null || typeof here !== "object") return undefined;
    here = (here as Record<string, unknown>)[segment];
  }
  return here;
}

/** Write `value` at `path` in `json`, in place, creating no containers:
 *  the parent must exist, since every path an edit writes was read from
 *  the same tree first. Returns false when it does not. */
export function setAt(json: unknown, path: string[], value: unknown): boolean {
  const parent = getAt(json, path.slice(0, -1));
  const leaf = path.at(-1);
  if (parent === null || typeof parent !== "object" || leaf === undefined) return false;
  (parent as Record<string, unknown>)[leaf] = value;
  return true;
}
