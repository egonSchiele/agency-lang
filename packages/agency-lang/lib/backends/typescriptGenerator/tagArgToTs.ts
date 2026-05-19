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
      };
      // For tag args we expect plain text segments (the parser doesn't
      // currently support interpolation here, but handle defensively).
      const parts: string[] = [];
      let raw = "";
      for (const seg of lit.segments) {
        if (seg.type === "text") {
          raw += seg.value ?? "";
        } else if (seg.expression) {
          parts.push(JSON.stringify(raw));
          parts.push(`(${tagArgToTs(seg.expression)})`);
          raw = "";
        }
      }
      parts.push(JSON.stringify(raw));
      return parts.length === 1 ? parts[0] : `(${parts.join(" + ")})`;
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
      // Restricted subset means we should not see anything else; emit a
      // clearly-broken value so the failure is obvious.
      return `/* unsupported tag arg: ${expr.type} */ undefined`;
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
