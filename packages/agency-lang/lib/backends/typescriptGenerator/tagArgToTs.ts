import type {
  Expression,
  AgencyObject,
  AgencyObjectKV,
  FunctionCall,
  Literal,
  SplatExpression,
  ValueAccess,
  AccessChainElement,
} from "../../types.js";

/**
 * Print a tag argument (an Agency Expression from the restricted subset
 * accepted inside `@validate(...)` / `@jsonSchema(...)`) as a valid
 * TypeScript expression string.
 *
 * Only the subset that the tag parser actually accepts is handled:
 * string / number / boolean / null literals, identifiers, function calls,
 * object literals (including spread). Anything else is a bug and produces
 * a clearly-broken output.
 *
 * `valueParamNames` (optional): when supplied, an identifier whose name
 * matches any entry throws — this catches accidental skips of the
 * value-parameter substitution pass. A value-param identifier must
 * never reach codegen; if it does, something upstream is broken and
 * we want it to fail loudly rather than emit a bogus reference to an
 * out-of-scope name.
 */
export function tagArgToTs(
  expr: Expression,
  valueParamNames?: ReadonlyArray<string>,
): string {
  switch (expr.type) {
    case "string":
    case "multiLineString": {
      const lit = expr as Literal & {
        segments: Array<{ type: "text" | "interpolation"; value?: string; expression?: Expression }>;
        loc?: { line: number; col: number };
      };
      // Tag-arg strings accept identifier-only `${name}` interpolation
      // (see `staticInterpolatedStringParser`). After value-param
      // substitution any `${valueParam}` slot has been replaced by a
      // literal text segment; any remaining interpolation slot must be
      // an identifier reference (typically a top-level static const)
      // that we emit as a TS template-literal `${ident}` reference.
      // If every segment is text, emit a plain JS string literal.
      const allText = lit.segments.every((s) => s.type === "text");
      if (allText) {
        let raw = "";
        for (const seg of lit.segments) raw += seg.value ?? "";
        return JSON.stringify(raw);
      }
      // Any remaining interpolation segments at this point are bugs:
      // the parser only accepts identifier-only `${name}` slots, and
      // substitution folds every value-param identifier away into a
      // text segment. A leftover `${name}` means the identifier did
      // not resolve to a value parameter of the surrounding alias —
      // e.g. a top-level static const, which we do not currently
      // support (tag args are emitted inside node-body schema chains
      // where module-level consts aren't bound to JS identifiers).
      const loc = lit.loc
        ? ` at line ${lit.loc.line}, col ${lit.loc.col}`
        : "";
      const offending = lit.segments.find((s) => s.type === "interpolation");
      const inner = offending?.expression as Expression | undefined;
      const name =
        inner && inner.type === "variableName"
          ? (inner as Literal & { value: string }).value
          : "<expression>";
      if (valueParamNames && valueParamNames.indexOf(name) !== -1) {
        throw new Error(
          `value param '${name}' left unsubstituted in tag-arg string — substitution pass not invoked?${loc}`,
        );
      }
      throw new Error(
        `tag-arg string interpolation '${"${"}${name}}' must reference a value parameter of the enclosing type alias${loc}`,
      );
    }
    case "number":
      return (expr as Literal & { value: string }).value;
    case "boolean":
      return String((expr as Literal & { value: boolean }).value);
    case "null":
      return "null";
    case "variableName": {
      const name = (expr as Literal & { value: string }).value;
      if (valueParamNames && valueParamNames.indexOf(name) !== -1) {
        throw new Error(
          `value param '${name}' left unsubstituted — substitution pass not invoked?`,
        );
      }
      return name;
    }
    case "agencyObject":
      return objectLiteralToTs(expr as AgencyObject, valueParamNames);
    case "functionCall": {
      const fc = expr as FunctionCall;
      return `${fc.functionName}(${functionCallArgsToTs(fc, valueParamNames)})`;
    }
    case "valueAccess": {
      const va = expr as ValueAccess;
      let out = tagArgToTs(va.base as Expression, valueParamNames);
      for (const el of va.chain) {
        out += renderChainElement(el, valueParamNames);
      }
      return out;
    }
    default:
      // Restricted subset means we should not see anything else; fail loudly
      // so the bug is obvious instead of emitting broken TS.
      throw new Error(
        `tagArgToTs: unsupported tag argument expression type "${(expr as Expression).type}"`,
      );
  }
}

function functionCallArgsToTs(
  fc: FunctionCall,
  valueParamNames?: ReadonlyArray<string>,
): string {
  return (fc.arguments ?? [])
    .map((a) =>
      a.type === "namedArgument"
        ? `${(a as any).name}: ${tagArgToTs((a as any).value, valueParamNames)}`
        : a.type === "splat"
          ? `...${tagArgToTs((a as any).value, valueParamNames)}`
          : tagArgToTs(a as Expression, valueParamNames),
    )
    .join(", ");
}

/**
 * Render an access-chain element as TS source. Tag-arg expressions only
 * need a small subset: property accesses (rare) and method calls — the
 * latter primarily for PFA validators like `min.partial(n: 0)`.
 *
 * When the method call's arguments are all named (the PFA shape), we
 * collect them into an object literal because `AgencyFunction.partial`
 * takes a single `Record<string, unknown>` of bindings at runtime.
 */
function renderChainElement(
  el: AccessChainElement,
  valueParamNames?: ReadonlyArray<string>,
): string {
  if (el.kind === "property") {
    return el.optional ? `?.${el.name}` : `.${el.name}`;
  }
  if (el.kind === "methodCall") {
    const fc = el.functionCall;
    const args = fc.arguments ?? [];
    const allNamed =
      args.length > 0 && args.every((a) => a.type === "namedArgument");
    const argStr = allNamed
      ? `{ ${args
          .map(
            (a) =>
              `${(a as any).name}: ${tagArgToTs((a as any).value, valueParamNames)}`,
          )
          .join(", ")} }`
      : functionCallArgsToTs(fc, valueParamNames);
    const dot = el.optional ? "?." : ".";
    return `${dot}${fc.functionName}(${argStr})`;
  }
  throw new Error(
    `tagArgToTs: unsupported access chain element "${(el as any).kind}"`,
  );
}

function objectLiteralToTs(
  obj: AgencyObject,
  valueParamNames?: ReadonlyArray<string>,
): string {
  const entries = obj.entries.map((entry) => {
    if ("key" in entry) {
      const kv = entry as AgencyObjectKV;
      // Quote keys with non-identifier characters; bare identifiers stay bare.
      const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(kv.key)
        ? kv.key
        : JSON.stringify(kv.key);
      return `${key}: ${tagArgToTs(kv.value, valueParamNames)}`;
    }
    const sp = entry as SplatExpression;
    return `...${tagArgToTs(sp.value, valueParamNames)}`;
  });
  return `{ ${entries.join(", ")} }`;
}
