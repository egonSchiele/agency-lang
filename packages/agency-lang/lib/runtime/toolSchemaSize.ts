/**
 * Flags tools whose JSON schema is large enough to be worth knowing about.
 *
 * A tool's schema is re-sent on every request for the life of a run, so an
 * oversized one is a standing tax on both cost and latency rather than a
 * one-off. The case that prompted this: `std::syntax::highlight` took a
 * `theme` parameter that accepted a nested color-scheme object, which
 * serialized to roughly 17,000 characters against a norm of a few hundred
 * for the rest of the stdlib. Nothing failed, so nothing surfaced it.
 */

/** Tools longer than this warn unless `agency.json` says otherwise. Every
 *  well-formed stdlib tool measured under 1,100 characters, so this leaves
 *  roughly 2x headroom before a schema is worth a second look. */
export const DEFAULT_MAX_TOOL_SCHEMA_CHARS = 2000;

export type OversizedTool = {
  name: string;
  chars: number;
};

/** `ToolDefinition.schema` is typed `unknown`, so the shape is checked at
 *  runtime rather than assumed. */
type ToolLike = {
  name?: string;
  schema?: unknown;
};

/**
 * Return the serialized length of a tool's JSON schema, or null when the
 * tool has no schema or the schema cannot be serialized. A tool that cannot
 * be measured is not a tool worth failing over, so callers treat null as
 * "nothing to report".
 */
export function toolSchemaChars(tool: ToolLike): number | null {
  const schema = tool?.schema as { toJSONSchema?: unknown } | null | undefined;
  const toJSONSchema = schema?.toJSONSchema;
  if (typeof toJSONSchema !== "function") return null;
  try {
    return JSON.stringify(toJSONSchema.call(schema)).length;
  } catch {
    return null;
  }
}

/**
 * Return the tools whose schema exceeds `threshold`, largest first.
 *
 * A threshold of 0 (or less) disables the check, matching how
 * `maxToolResultChars` treats 0.
 */
export function findOversizedTools(
  tools: ToolLike[],
  threshold: number,
): OversizedTool[] {
  if (threshold <= 0) return [];
  const oversized: OversizedTool[] = [];
  for (const tool of tools) {
    const chars = toolSchemaChars(tool);
    if (chars !== null && chars > threshold) {
      oversized.push({ name: tool.name ?? "(unnamed)", chars });
    }
  }
  return oversized.sort((a, b) => b.chars - a.chars);
}

/** The warning text a flagged tool produces. */
export function oversizedToolMessage(
  tool: OversizedTool,
  threshold: number,
): string {
  return (
    `Tool "${tool.name}" has a ${tool.chars}-character JSON schema, over the ` +
    `${threshold}-character warning threshold. Every request in this run ` +
    `carries it. Narrow the parameter types (a union of allowed names beats ` +
    `an open object), or set client.maxToolSchemaChars in agency.json.`
  );
}

/** The slice of RuntimeContext this module needs; typed structurally so the
 *  runtime's generic context type does not have to be imported here. */
type SchemaWarnHost = {
  maxToolSchemaChars?: number;
  warnedToolSchemas?: Record<string, true>;
  statelogClient: {
    warn: (payload: {
      warnType: "toolSchemaSize";
      message: string;
      functionName: string;
      schemaChars: number;
      threshold: number;
    }) => Promise<unknown>;
  };
};

/** Report any tool whose JSON schema is over the configured threshold. The
 *  schema rides along on every request in the run, so this is a standing
 *  cost the caller usually cannot see: nothing fails, the bill is just
 *  higher and the context fuller. Warned once per tool name per run —
 *  repeating it on all 26 calls of a run would bury the signal in the
 *  statelog it is meant to surface in.
 *
 *  Never throws. A tool the runtime cannot measure is skipped, and a
 *  statelog post that fails is swallowed: a diagnostic must not be able to
 *  take down the call it is describing. */
export function warnOnOversizedToolSchemas(
  ctx: SchemaWarnHost,
  tools: { name: string; schema?: unknown }[],
): void {
  const threshold = ctx.maxToolSchemaChars ?? DEFAULT_MAX_TOOL_SCHEMA_CHARS;
  if (threshold <= 0) return;
  const alreadyWarned = (ctx.warnedToolSchemas ??= {});
  for (const tool of findOversizedTools(tools, threshold)) {
    if (alreadyWarned[tool.name]) continue;
    alreadyWarned[tool.name] = true;
    void ctx.statelogClient
      .warn({
        warnType: "toolSchemaSize",
        message: oversizedToolMessage(tool, threshold),
        functionName: tool.name,
        schemaChars: tool.chars,
        threshold,
      })
      .catch(() => {});
  }
}
