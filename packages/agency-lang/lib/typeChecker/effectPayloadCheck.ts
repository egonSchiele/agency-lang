import { isAnyType } from "./utils.js";
import { diagnostic } from "./diagnostics.js";
import type { TypeCheckerContext, ScopeInfo } from "./types.js";
import type { EffectDeclaration } from "../types/effectDeclaration.js";
import type { VariableType } from "../types.js";
import type { ObjectType } from "../types/typeHints.js";
import type { InterruptStatement } from "../types/interruptStatement.js";
import { walkNodes } from "../utils/node.js";
import type { Tag } from "../types/tag.js";
import {
  tagsAbove,
  effectDeclarationsWithTags,
  type NodeWithTagsAbove,
} from "../utils/tagsAbove.js";
import type { TypeCheckError } from "./types.js";
import type { SourceLocation } from "../types/base.js";
import {
  readAlwaysScope,
  hasAlwaysScope,
  isAlwaysTag,
  ALWAYS_TAG,
  ALWAYS_UNDER_TAG,
} from "./alwaysTag.js";
import type { AlwaysProblemKind, AlwaysTagProblem } from "./alwaysTag.js";
import { sameScopedFields, type ScopedField } from "../runtime/alwaysScope.js";
import {
  isCapabilitiesTag,
  readCapabilities,
  sameCapabilities,
  type CapabilitiesRead,
  type CapabilitiesTagProblem,
} from "./capabilitiesTag.js";
import { CAPABILITIES, type Capability } from "../host/host.js";
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
    ctx.errors.push(...alwaysScopeDiagnostics(effect, entries, merged));
    ctx.errors.push(...capabilitiesDiagnostics(effect, entries));
    if (merged) registry[effect] = merged;
  }
  ctx.errors.push(...strayAlwaysTagDiagnostics(ctx));
  ctx.errors.push(...strayCapabilitiesTagDiagnostics(ctx));
  return registry;
}

/**
 * What each effect needs from the host, from the `@capabilities` tags on
 * its declarations across the import closure. An effect with no tagged
 * declaration needs nothing and is not listed. Reports nothing; the
 * diagnostics come from `buildEffectRegistry`.
 */
export function buildEffectCapabilities(ctx: TypeCheckerContext): Record<string, Capability[]> {
  const capabilities: Record<string, Capability[]> = Object.create(null);
  for (const { decl } of collectDeclarations(ctx)) {
    const read = readCapabilities(decl.tags);
    if (!read.tagged) {
      continue;
    }
    const known = capabilities[decl.effect] ?? [];
    capabilities[decl.effect] = [
      ...known,
      ...read.capabilities.filter((capability) => !known.includes(capability)),
    ];
  }
  return capabilities;
}

/** Prefer the import closure (ambient); fall back to the current program's
 *  own declarations when there's no symbol table (raw-program callers).
 *  Deep-walks so body-scoped declarations are picked up too — mirrors
 *  `SymbolTable.build`'s collection. */
function collectDeclarations(ctx: TypeCheckerContext): DeclEntry[] {
  if (ctx.symbolTable) return ctx.symbolTable.allEffectDeclarations();
  const file = ctx.currentFile ?? "<program>";
  return effectDeclarationsWithTags(ctx.programNodes).map((decl) => ({ decl, file }));
}

function groupBy<T, K extends string>(items: T[], key: (t: T) => K): Record<K, T[]> {
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
    ctx.errors.push(diagnostic("effectDeclaredTwice", { effect }, dups[1].decl.loc ?? null));
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
  ctx.errors.push(diagnostic("effectPayloadConflict", { effect }, conflict.decl.loc ?? null));
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
  if (isAnyType(argType)) return; // can't say anything useful

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

type TaggedDecl = { decl: EffectDeclaration; scope: ReturnType<typeof readAlwaysScope> };

type ProblemParams = { tag: string; effect: string };
type ProblemDiagnostic = (params: ProblemParams, loc: SourceLocation | null) => TypeCheckError;

/** Which diagnostic each tag-reading problem becomes. One fact, one place. */
const PROBLEM_DIAGNOSTIC: Record<AlwaysProblemKind, ProblemDiagnostic> = {
  badArgument: (params, loc) => diagnostic("alwaysBadArgument", params, loc),
  namedTwice: (params, loc) => diagnostic("alwaysBadArgument", params, loc),
  repeatedTag: (params, loc) => diagnostic("alwaysRepeatedTag", params, loc),
};

function problemDiagnostic(
  effect: string,
  tagged: TaggedDecl,
  problem: AlwaysTagProblem,
): TypeCheckError {
  const params = { tag: problem.tag, effect };
  return PROBLEM_DIAGNOSTIC[problem.kind](params, problem.loc ?? tagged.decl.loc ?? null);
}

function unknownFieldDiagnostic(
  effect: string,
  tagged: TaggedDecl,
  field: ScopedField,
): TypeCheckError {
  const tag = field.matchSubpaths ? ALWAYS_UNDER_TAG : ALWAYS_TAG;
  return diagnostic(
    "alwaysUnknownField",
    { tag, field: field.field, effect },
    tagged.decl.loc ?? null,
  );
}

function isInPayload(payload: ObjectType, field: ScopedField): boolean {
  return payload.properties.some((property) => property.key === field.field);
}

/**
 * Diagnostics for the @always / @alwaysUnder tags across every declaration
 * of one effect. Only TAGGED declarations take part: an untagged
 * redeclaration (the guide shows users writing `effect std::read {...}`
 * with no tag) inherits the tagged scope and raises nothing. Among the
 * tagged ones: arguments are identifiers, each tag appears once, every
 * field exists in the payload, and all of them agree.
 */
function alwaysScopeDiagnostics(
  effect: string,
  entries: DeclEntry[],
  payload: ObjectType | null,
): TypeCheckError[] {
  const tagged: TaggedDecl[] = entries
    .filter((entry) => hasAlwaysScope(entry.decl.tags))
    .map((entry) => ({ decl: entry.decl, scope: readAlwaysScope(entry.decl.tags) }));

  const problems = tagged.flatMap((one) =>
    one.scope.problems.map((problem) => problemDiagnostic(effect, one, problem)),
  );
  const unknownFields =
    payload === null
      ? []
      : tagged.flatMap((one) =>
          one.scope.fields
            .filter((field) => !isInPayload(payload, field))
            .map((field) => unknownFieldDiagnostic(effect, one, field)),
        );
  const [first, ...rest] = tagged;
  const conflicts =
    first === undefined
      ? []
      : rest
          .filter((one) => !sameScopedFields(first.scope.fields, one.scope.fields))
          .map((one) => diagnostic("alwaysScopeConflict", { effect }, one.decl.loc ?? null));

  return [...problems, ...unknownFields, ...conflicts];
}

/**
 * An always-tag anywhere but directly above an effect declaration: above a
 * def, type, node, or import, or trailing at the end of a list. The
 * typechecker sees the raw program, so "above" is read with `tagsAbove`;
 * a tag the preprocessor already attached shows up on `node.tags` instead,
 * and both places are checked.
 */
function strayAlwaysTags(entry: NodeWithTagsAbove): Tag[] {
  if (entry.node?.type === "effectDeclaration") {
    return [];
  }
  const attached = (entry.node as { tags?: Tag[] } | null)?.tags ?? [];
  return [...entry.tags, ...attached].filter(isAlwaysTag);
}

function strayAlwaysTagDiagnostics(ctx: TypeCheckerContext): TypeCheckError[] {
  return tagsAbove(ctx.programNodes)
    .flatMap(strayAlwaysTags)
    .map((tag) => diagnostic("alwaysStrayTag", { tag: tag.name }, tag.loc ?? null));
}

type CapabilitiesDecl = { decl: EffectDeclaration; read: CapabilitiesRead };

function capabilitiesProblemDiagnostic(
  effect: string,
  one: CapabilitiesDecl,
  problem: CapabilitiesTagProblem,
): TypeCheckError {
  const loc = problem.loc ?? one.decl.loc ?? null;
  if (problem.kind === "unknownName") {
    return diagnostic(
      "capabilityUnknown",
      {
        name: problem.name ?? "",
        effect,
        suggestion: problem.suggestion ?? "",
        known: CAPABILITIES.join(", "),
      },
      loc,
    );
  }
  if (problem.kind === "repeatedTag") {
    return diagnostic("capabilitiesRepeatedTag", { effect }, loc);
  }
  return diagnostic("capabilitiesBadArgument", { effect }, loc);
}

/**
 * Diagnostics for the @capabilities tag across every declaration of one
 * effect. As with @always, only tagged declarations take part, so a user's
 * untagged `effect std::read {...}` inherits the stdlib's tag. Among the
 * tagged ones: every argument is a known capability name, the tag appears
 * once, and all of them agree.
 */
function capabilitiesDiagnostics(effect: string, entries: DeclEntry[]): TypeCheckError[] {
  const tagged: CapabilitiesDecl[] = entries
    .map((entry) => ({ decl: entry.decl, read: readCapabilities(entry.decl.tags) }))
    .filter((one) => one.read.tagged);
  const problems = tagged.flatMap((one) =>
    one.read.problems.map((problem) => capabilitiesProblemDiagnostic(effect, one, problem)),
  );
  const [first, ...rest] = tagged;
  const conflicts =
    first === undefined
      ? []
      : rest
          .filter((one) => !sameCapabilities(first.read.capabilities, one.read.capabilities))
          .map((one) => diagnostic("capabilitiesConflict", { effect }, one.decl.loc ?? null));
  return [...problems, ...conflicts];
}

/** A @capabilities tag anywhere but directly above an effect declaration,
 *  found the same two ways as a stray @always tag. */
function strayCapabilitiesTags(entry: NodeWithTagsAbove): Tag[] {
  if (entry.node?.type === "effectDeclaration") {
    return [];
  }
  const attached = (entry.node as { tags?: Tag[] } | null)?.tags ?? [];
  return [...entry.tags, ...attached].filter(isCapabilitiesTag);
}

function strayCapabilitiesTagDiagnostics(ctx: TypeCheckerContext): TypeCheckError[] {
  return tagsAbove(ctx.programNodes)
    .flatMap(strayCapabilitiesTags)
    .map((tag) => diagnostic("capabilitiesStrayTag", {}, tag.loc ?? null));
}
