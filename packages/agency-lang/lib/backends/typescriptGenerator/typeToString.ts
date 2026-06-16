import { Expression } from "../../types.js";
import { VariableType } from "../../types.js";

const MAX_LENGTH = 50;

/**
 * Print one entry of `valueArgs` (a tag-arg expression) back to Agency
 * source text. Inlined here to avoid importing `expressionToString` from
 * `lib/utils/node.ts`, which already imports `variableTypeToString` and
 * would form a cycle. The subset matches `staticTagArgParser`: literals,
 * identifiers, valueAccess (PFA), and object literals. Anything else
 * falls back to an empty string — a missing arg is preferable to a
 * crash inside the formatter.
 */
function valueArgExprToString(expr: Expression): string {
  switch (expr.type) {
    case "variableName":
      return expr.value;
    case "number":
      return expr.value;
    case "boolean":
      return String(expr.value);
    case "null":
      return "null";
    case "string":
    case "multiLineString": {
      const body = expr.segments
        .map((seg) =>
          seg.type === "text"
            ? seg.value
            : `\${${valueArgExprToString(seg.expression)}}`,
        )
        .join("");
      return `"${body}"`;
    }
    case "valueAccess": {
      let code = valueArgExprToString(expr.base as Expression);
      for (const element of expr.chain) {
        switch (element.kind) {
          case "property":
            code += `.${element.name}`;
            break;
          case "index":
            code += `[${valueArgExprToString(element.index as Expression)}]`;
            break;
          case "methodCall": {
            const fc = element.functionCall;
            const args = fc.arguments
              .map((arg) => {
                if ("name" in arg && arg.name) {
                  return `${arg.name}: ${valueArgExprToString(arg.value as Expression)}`;
                }
                return valueArgExprToString(
                  ("value" in arg ? arg.value : arg) as Expression,
                );
              })
              .join(", ");
            code += `.${fc.functionName}(${args})`;
            break;
          }
        }
      }
      return code;
    }
    case "agencyObject":
      return `{ ${expr.entries
        .map((entry) => {
          if ("type" in entry && entry.type === "splat") {
            return `...${valueArgExprToString(entry.value)}`;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const e = entry as any;
          return `${e.key}: ${valueArgExprToString(e.value)}`;
        })
        .join(", ")} }`;
    case "agencyArray":
      return `[${expr.items
        .map((item) =>
          item.type === "splat"
            ? `...${valueArgExprToString(item.value)}`
            : valueArgExprToString(item as Expression),
        )
        .join(", ")}]`;
    case "regex":
      return `re/${expr.pattern}/${expr.flags}`;
    case "unitLiteral":
      // Round-trip the source form (`30s`, `$5`, `100KB`, ...). `$`
      // is the only prefix unit; everything else is a suffix.
      return expr.unit === "$"
        ? `$${expr.value}`
        : `${expr.value}${expr.unit}`;
    default:
      return "";
  }
}

function formatValueArgs(valueArgs: Expression[] | undefined): string {
  if (!valueArgs || valueArgs.length === 0) return "";
  return `(${valueArgs.map(valueArgExprToString).join(", ")})`;
}

/**
 * Converts a VariableType to a string representation for naming/logging
 */
// Render one member of an effect-set literal in Agency `<...>` form:
// a namespaced/bare label prints unquoted; a nested set reference prints
// its name. Guard clauses, no nested ternaries.
function effectSetMemberToSource(
  member: VariableType,
  typeAliases: Record<string, VariableType>,
): string {
  if (member.type === "stringLiteralType") return member.value;
  if (member.type === "typeAliasVariable") return member.aliasName;
  return variableTypeToString(member, typeAliases, true);
}

export function variableTypeToString(
  variableType: VariableType,
  typeAliases: Record<string, VariableType>,
  forFormatting: boolean = false,
): string {
  if (variableType.type === "primitiveType") {
    if (variableType.value === "object") {
      if (forFormatting) {
        return "object";
      }
      return "Record<string, any>";
    }
    return variableType.value;
  } else if (variableType.type === "arrayType") {
    // Recursively build array type string
    return `${variableTypeToString(variableType.elementType, typeAliases, forFormatting)}[]`;
  } else if (variableType.type === "stringLiteralType") {
    return `"${variableType.value}"`;
  } else if (variableType.type === "numberLiteralType") {
    return `${variableType.value}`;
  } else if (variableType.type === "booleanLiteralType") {
    return `${variableType.value}`;
  } else if (variableType.type === "unionType") {
    // Effect sets print as `<a, b>` in Agency source. Only in the
    // formatting dialect — TS codegen never sees an effect set as a value
    // type, and would want the plain `a | b` form anyway.
    if (forFormatting && variableType.isEffectSet) {
      const members = variableType.types
        .map((t) => effectSetMemberToSource(t, typeAliases))
        .join(", ");
      return `<${members}>`;
    }
    const str = variableType.types
      .map((t) => variableTypeToString(t, typeAliases, forFormatting))
      .join(" | ");
    if (str.length > MAX_LENGTH) {
      const arr = str.split(" | ");
      return "\n  | " + arr.join("\n  | ");
    }
    return str;
  } else if (variableType.type === "objectType") {
    const props = variableType.properties
      .map(
        (prop) =>
          `${prop.key}: ${variableTypeToString(prop.value, typeAliases, forFormatting)}`,
      )
      .join("; ");
    return `{ ${props} }`;
  } else if (variableType.type === "typeAliasVariable") {
    return `${variableType.aliasName}${formatValueArgs(variableType.valueArgs)}`;
  } else if (variableType.type === "blockType") {
    // Dialect-keyed arrow: `->` for Agency source, `=>` for TypeScript
    // codegen. Param names are surfaced in both dialects when present
    // (TS function types accept named params).
    const arrow = forFormatting ? "->" : "=>";
    const params = variableType.params
      .map((p) => {
        const t = variableTypeToString(
          p.typeAnnotation,
          typeAliases,
          forFormatting,
        );
        return p.name ? `${p.name}: ${t}` : t;
      })
      .join(", ");
    const ret = variableTypeToString(variableType.returnType, typeAliases, forFormatting);
    return `(${params}) ${arrow} ${ret}`;
  } else if (variableType.type === "resultType") {
    const s = variableTypeToString(variableType.successType, typeAliases, forFormatting);
    const f = variableTypeToString(variableType.failureType, typeAliases, forFormatting);
    if (s === "any" && f === "any") return "Result";
    if (f === "string") return `Result<${s}>`;
    return `Result<${s}, ${f}>`;
  } else if (variableType.type === "genericType") {
    const args = variableType.typeArgs
      .map((a) => variableTypeToString(a, typeAliases, forFormatting))
      .join(", ");
    return `${variableType.name}<${args}>${formatValueArgs(variableType.valueArgs)}`;
  }
  return "unknown";
}
