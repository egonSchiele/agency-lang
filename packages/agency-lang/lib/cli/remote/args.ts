// Named arguments for `remote call`, from repeatable `--arg name=value` pairs
// over an optional `--data` JSON-object base. Each value is JSON-parsed when it
// can be (so `count=3` -> 3, `flag=true` -> true) and kept as a string
// otherwise (so `msg=hi` -> "hi").

export type RemoteArgsOptions = {
  arg?: string[];
  data?: string;
};

export function buildArgs(options: RemoteArgsOptions): Record<string, unknown> {
  // Null-prototype: arg names are user-controlled, so a key like "__proto__"
  // must be a plain data property, not a write to the object's prototype.
  const args: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(parseDataBase(options.data))) {
    args[key] = value;
  }
  for (const pair of options.arg ?? []) {
    const equals = pair.indexOf("=");
    if (equals <= 0) {
      throw new Error(`--arg must be name=value (got '${pair}')`);
    }
    args[pair.slice(0, equals)] = coerce(pair.slice(equals + 1));
  }
  return args;
}

function parseDataBase(data: string | undefined): Record<string, unknown> {
  if (data === undefined) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error(`--data is not valid JSON: ${data}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--data must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** JSON when it parses, otherwise the raw string. */
function coerce(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
