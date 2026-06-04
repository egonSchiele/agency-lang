/**
 * Single source of truth for the wording of "unbound function-typed tool
 * parameter" diagnostics.
 *
 * Both the compile-time tool-binding validator
 * (`lib/typeChecker/toolBlockBinding.ts`) and the runtime backstop
 * (`AgencyFunction.validateForLLM` in `agencyFunction.ts`) emit messages
 * built from `formatUnboundClause`. The canonical clause
 *   `required function-typed parameter '<name>' is unbound`
 * appears in both messages — the test plan (§5.4 #42) pins that overlap
 * explicitly so the checker and runtime cannot drift apart silently.
 */

/** Canonical clause shared by compile-time and runtime errors. */
export function formatUnboundClause(paramName: string): string {
  return `required function-typed parameter '${paramName}' is unbound`;
}

/** Compile-time tool-binding diagnostic. */
export function formatRequiredUnboundError(
  toolName: string,
  paramName: string,
  paramType?: string,
): string {
  const typeFragment = paramType ? ` (${paramType})` : "";
  return (
    `Tool '${toolName}' has ${formatUnboundClause(paramName)}${typeFragment}. ` +
    `Bind it with .partial(${paramName}: <value>) before passing as a tool.`
  );
}

/** Runtime backstop diagnostic — same canonical clause, slightly different framing. */
export function formatRequiredUnboundRuntimeError(
  toolName: string,
  paramName: string,
): string {
  return (
    `Tool '${toolName}' cannot be passed to llm(): ${formatUnboundClause(paramName)}. ` +
    `Use ${toolName}.partial(${paramName}: <value>) before passing.`
  );
}

/** One aggregated warning per llm(...) site listing all optional drops. */
export function formatOptionalUnboundWarning(
  toolName: string,
  paramNames: string[],
): string {
  const list = paramNames.map((n) => `'${n}'`).join(", ");
  // "Optional" here means the param declares a default value. When the
  // LLM omits it, the normal defaulting path fills in that declared
  // default (often `null`), not `undefined` — so the body must be ready
  // to run with whatever the default is.
  return (
    `Tool '${toolName}' will be exposed to the LLM without optional ` +
    `function-typed parameter(s): ${list}. The function body must be ` +
    `prepared to run with the declared default for each.`
  );
}
