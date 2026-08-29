/**
 * Which payload fields an "approve always here" policy rule pins, per
 * effect. Filled by generated code: each `effect` declaration carrying an
 * `@always` / `@alwaysUnder` tag compiles to one `__registerAlwaysScope`
 * call at module JS-load. Read by `std::policy` when it builds a scoped
 * rule and when it decides whether to offer the option at all.
 *
 * Process-wide and derived from code, like `crossModuleInitRegistry.ts`.
 * Never checkpointed: a resume re-imports the modules and re-registers.
 */

export type ScopedField = { field: string; matchSubpaths: boolean };

// Null prototype: effect names are user-controlled strings.
const scopes: Record<string, ScopedField[]> = Object.create(null);

function includesField(fields: ScopedField[], wanted: ScopedField): boolean {
  return fields.some(
    (field) => field.field === wanted.field && field.matchSubpaths === wanted.matchSubpaths,
  );
}

/** Same fields, in any order. The typechecker and the registry share this
 *  so "these two declarations agree" means one thing. */
export function sameScopedFields(a: ScopedField[], b: ScopedField[]): boolean {
  return a.length === b.length && a.every((field) => includesField(b, field));
}

function describe(fields: ScopedField[]): string {
  return `[${fields.map((field) => field.field).join(", ")}]`;
}

function copyOf(fields: ScopedField[]): ScopedField[] {
  return fields.map((field) => ({ ...field }));
}

function isScopedField(value: unknown): value is ScopedField {
  const candidate = value as { field?: unknown; matchSubpaths?: unknown } | null;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.field === "string" &&
    typeof candidate.matchSubpaths === "boolean"
  );
}

/**
 * Take a scope that arrived from a subprocess with one of its interrupts.
 * The child is untrusted, so this never throws and never replaces a scope
 * this process already holds from its own compiled declarations: it fills
 * a gap only. A malformed value is ignored. The prompt still shows the
 * exact fields any rule would pin, and a scope whose fields the payload
 * lacks yields no rule at all (see `buildScopedMatch` in std::policy).
 */
export function adoptAlwaysScope(effect: string, fields: unknown): void {
  const known = scopes[effect] !== undefined;
  const wellFormed = Array.isArray(fields) && fields.every(isScopedField);
  if (known || !wellFormed) {
    return;
  }
  __registerAlwaysScope(effect, fields);
}

export function __registerAlwaysScope(effect: string, fields: ScopedField[]): void {
  // An empty scope says nothing, so it cannot contradict a scope already
  // registered.
  if (fields.length === 0) {
    return;
  }
  const existing = scopes[effect] ?? [];
  if (sameScopedFields(existing, fields)) {
    return;
  }
  if (existing.length > 0) {
    throw new Error(
      `Effect '${effect}' registered two different @always scopes: ${describe(existing)} and ${describe(fields)}`,
    );
  }
  scopes[effect] = copyOf(fields);
}

export function alwaysScopeFor(effect: string): ScopedField[] {
  return copyOf(scopes[effect] ?? []);
}

export function allAlwaysScopes(): Record<string, ScopedField[]> {
  return Object.fromEntries(Object.keys(scopes).map((effect) => [effect, alwaysScopeFor(effect)]));
}
