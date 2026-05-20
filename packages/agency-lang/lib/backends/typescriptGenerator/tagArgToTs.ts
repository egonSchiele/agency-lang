import type {
  Expression,
  AgencyObject,
  AgencyObjectKV,
  FunctionCall,
  Literal,
  SplatExpression,
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
 */
export function tagArgToTs(expr: Expression): string {
  switch (expr.type) {
    case "string":
    case "multiLineString": {
      const lit = expr as Literal & {
        segments: Array<{ type: "text" | "interpolation"; value?: string; expression?: Expression }>;
        loc?: { line: number; col: number };
      };
      // Tag-arg strings must be plain literals: the parser uses
      // `simpleStringParser`, which never produces interpolation segments.
      // If we ever see one here, that's a bug — fail loudly rather than
      // emit broken TypeScript.
      let raw = "";
      for (const seg of lit.segments) {
        if (seg.type === "text") {
          raw += seg.value ?? "";
        } else {
          const loc = lit.loc
            ? ` at line ${lit.loc.line}, col ${lit.loc.col}`
            : "";
          throw new Error(
            `Tag arguments must be plain string literals (no interpolation)${loc}`,
          );
        }
      }
      return JSON.stringify(raw);
    }
    case "number":
      return (expr as Literal & { value: string }).value;
    case "boolean":
      return String((expr as Literal & { value: boolean }).value);
    case "null":
      return "null";
    case "variableName":
      return (expr as Literal & { value: string }).value;
    case "agencyObject":
      return objectLiteralToTs(expr as AgencyObject);
    case "functionCall": {
      const fc = expr as FunctionCall;
      const args = (fc.arguments ?? [])
        .map((a) =>
          a.type === "namedArgument"
            ? `${(a as any).name}: ${tagArgToTs((a as any).value)}`
            : a.type === "splat"
              ? `...${tagArgToTs((a as any).value)}`
              : tagArgToTs(a as Expression),
        )
        .join(", ");
      return `${fc.functionName}(${args})`;
    }
    default:
      // Restricted subset means we should not see anything else; fail loudly
      // so the bug is obvious instead of emitting broken TS.
      throw new Error(
        `tagArgToTs: unsupported tag argument expression type "${(expr as Expression).type}"`,
      );
  }
}

function objectLiteralToTs(obj: AgencyObject): string {
  const entries = obj.entries.map((entry) => {
    if ("key" in entry) {
      const kv = entry as AgencyObjectKV;
      // Quote keys with non-identifier characters; bare identifiers stay bare.
      const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(kv.key)
        ? kv.key
        : JSON.stringify(kv.key);
      return `${key}: ${tagArgToTs(kv.value)}`;
    }
    const sp = entry as SplatExpression;
    return `...${tagArgToTs(sp.value)}`;
  });
  return `{ ${entries.join(", ")} }`;
}
