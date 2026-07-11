import { diagnostic } from "./diagnostics.js";
import type { TypeCheckerContext, ScopeInfo } from "./types.js";
import type { EffectDeclaration } from "../types/effectDeclaration.js";
import type { VariableType } from "../types.js";
import type { ObjectType } from "../types/typeHints.js";
import type { InterruptStatement } from "../types/interruptStatement.js";
import { walkNodes } from "../utils/node.js";
import { synthType } from "./synthesizer.js";
import { isAssignable } from "./assignability.js";

/**
 * Check every interrupt raise site's payload against its declared type. The
 * effect→payload registry is built via `buildEffectRegistry` (reporting
 * conflicting / duplicate declarations as a side effect). Callers that already
 * built the registry — H3 shares ONE across passes — pass it in to avoid
 * rebuilding it (which would double-report those conflicts).
 */
export function checkEffectPayloads(
  scopes: ScopeInfo[],
  ctx: TypeCheckerContext,
  registry?: Record<string, ObjectType>,
): void {
  const reg = registry ?? buildEffectRegistry(ctx);

  for (const info of scopes) {
    if (!info.name || info.name === "top-level") continue;
    ctx.withScope(info.scopeKey, () => {
      for (const { node } of walkNodes(info.body)) {
        if (node.type !== "interruptStatement") continue;
        // Own-property guard: `node.effect` is a user-controlled string, so a
        // reserved key must not resolve a payload via Object.prototype.
        if (!Object.prototype.hasOwnProperty.call(reg, node.effect)) continue;
        const payloadType = reg[node.effect];
        checkRaiseSite(node, payloadType, info, ctx);
      }
    });
  }
}

type DeclEntry = { decl: EffectDeclaration; file: string };

/**
 * Registry assembly is a 3-step pipeline:
 *   collect → group-by-effect → for each effect: validate + merge.
 * Validation pushes diagnostics; merge returns the agreed type or `null` on
 * conflict (so we drop the effect from the registry — see `mergePayload`).
 */
export function buildEffectRegistry(ctx: TypeCheckerContext): Record<string, ObjectType> {
  const grouped = groupBy(collectDeclarations(ctx), (e) => e.decl.effect);
  // Null-prototype dict: effect names are user-controlled strings (they may be
  // bare identifiers), so a reserved key like "__proto__"/"constructor"/"toString"
  // must not corrupt the registry on write or resolve via Object.prototype on read.
  const registry: Record<string, ObjectType> = Object.create(null);
  for (const [effect, entries] of Object.entries(grouped)) {
    reportSameFileDuplicates(effect, entries, ctx);
    const merged = mergePayload(effect, entries, ctx);
    if (merged) registry[effect] = merged;
  }
  return registry;
}

/** Prefer the import closure (ambient); fall back to the current program's
 *  own declarations when there's no symbol table (raw-program callers).
 *  Deep-walks so body-scoped declarations are picked up too — mirrors
 *  `SymbolTable.build`'s collection. */
function collectDeclarations(ctx: TypeCheckerContext): DeclEntry[] {
  if (ctx.symbolTable) return ctx.symbolTable.allEffectDeclarations();
  const file = ctx.currentFile ?? "<program>";
  const out: DeclEntry[] = [];
  for (const { node } of walkNodes(ctx.programNodes)) {
    if (node.type === "effectDeclaration") out.push({ decl: node, file });
  }
  return out;
}

function groupBy<T, K extends string>(
  items: T[],
  key: (t: T) => K,
): Record<K, T[]> {
  // Null-prototype accumulator: keys derive from user-controlled strings (effect
  // names, file paths), so a reserved key must not read/write Object.prototype.
  const out = Object.create(null) as Record<K, T[]>;
  for (const item of items) (out[key(item)] ??= []).push(item);
  return out;
}

/** Emit one diagnostic per file that contains 2+ declarations of `effect`. */
function reportSameFileDuplicates(
  effect: string,
  entries: DeclEntry[],
  ctx: TypeCheckerContext,
): void {
  const byFile = groupBy(entries, (e) => e.file);
  for (const [, dups] of Object.entries(byFile)) {
    if (dups.length < 2) continue;
    // point at the redundant declaration
    ctx.errors.push(
      diagnostic("effectDeclaredTwice", { effect }, dups[1].decl.loc ?? null),
    );
  }
}

/**
 * All declarations of one effect must agree on their payload type. Returns
 * the agreed `ObjectType` when they do, `null` when they don't (and pushes
 * a conflict error). We deliberately drop conflicting effects from the
 * registry so raise sites for them aren't double-flagged with derivative
 * errors — the single conflict diagnostic is the actionable signal.
 */
function mergePayload(
  effect: string,
  entries: DeclEntry[],
  ctx: TypeCheckerContext,
): ObjectType | null {
  const [first, ...rest] = entries;
  const aliases = ctx.getTypeAliases();
  const conflict = rest.find(
    (e) => !typesEqual(e.decl.payloadType, first.decl.payloadType, aliases),
  );
  if (!conflict) return first.decl.payloadType;
  ctx.errors.push(
    diagnostic("effectPayloadConflict", { effect }, conflict.decl.loc ?? null),
  );
  return null;
}

/** Structural equality via mutual assignability. */
function typesEqual(
  a: VariableType,
  b: VariableType,
  aliases: Parameters<typeof isAssignable>[2],
): boolean {
  return isAssignable(a, b, aliases) && isAssignable(b, a, aliases);
}

function checkRaiseSite(
  node: InterruptStatement,
  payloadType: ObjectType,
  info: ScopeInfo,
  ctx: TypeCheckerContext,
): void {
  const required = payloadType.properties;

  // `raise`/`interrupt` is a positional special-form: arg[0] is the message,
  // arg[1] is the object that becomes `interrupt.data` at runtime. There is
  // no named parameter — reject named args at this site as a separate error.
  const named = node.arguments.find((a) => a.type === "namedArgument");
  if (named) {
    ctx.errors.push(diagnostic("namedArgsOnRaise", {}, node.loc ?? null));
    return;
  }

  // Any splat anywhere in the args unpacks into multiple positional args, so
  // we can't determine which element becomes the data object. Skip silently;
  // the splat's own type-check happens elsewhere. (Phase-1 limitation.)
  if (node.arguments.some((a) => a.type === "splat")) return;

  const dataArg = node.arguments[1] ?? null;

  // No data supplied.
  if (!dataArg) {
    if (required.length > 0) {
      ctx.errors.push(
        diagnostic(
          "effectDataMissing",
          { effect: node.effect, payload: formatObject(payloadType) },
          node.loc ?? null,
        ),
      );
    }
    return; // empty declaration + no data is fine
  }

  // After the named/splat filters above, `dataArg` is a positional Expression
  // which is a subset of AgencyNode (the union just isn't narrow enough for TS).
  const argType = synthType(dataArg as Parameters<typeof synthType>[0], info.scope, ctx);
  if (argType === "any") return; // can't say anything useful

  // Per-field checks against the resolved data object for precise messages.
  if (argType.type === "objectType") {
    for (const prop of required) {
      const got = argType.properties.find((p) => p.key === prop.key);
      if (!got) {
        ctx.errors.push(
          diagnostic(
            "effectDataFieldMissing",
            { effect: node.effect, field: prop.key },
            node.loc ?? null,
          ),
        );
        continue;
      }
      if (!isAssignable(got.value, prop.value, ctx.getTypeAliases())) {
        ctx.errors.push(
          diagnostic(
            "effectDataFieldWrongType",
            { effect: node.effect, field: prop.key },
            node.loc ?? null,
          ),
        );
      }
    }
    return;
  }

  // Non-object data (e.g. a variable): fall back to whole-type assignability.
  if (!isAssignable(argType, payloadType, ctx.getTypeAliases())) {
    ctx.errors.push(
      diagnostic(
        "effectDataMismatch",
        { effect: node.effect, payload: formatObject(payloadType) },
        node.loc ?? null,
      ),
    );
  }
}

function formatObject(t: ObjectType): string {
  return `{ ${t.properties.map((p) => p.key).join(", ")} }`;
}
