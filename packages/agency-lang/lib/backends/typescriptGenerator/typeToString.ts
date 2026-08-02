import { Expression } from "../../types.js";
import { VariableType } from "../../types.js";
import type { ObjectType } from "../../types.js";

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
                if ("name" in arg && arg.name && arg.type !== "hole") {
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
  hooks?: TypePrintHooks,
): string {
  if (member.type === "stringLiteralType") return member.value;
  if (member.type === "typeAliasVariable") return member.aliasName;
  return variableTypeToString(member, typeAliases, true, hooks);
}

/** Render a `raises` clause back to Agency source: `<*>` for the `any`
 *  primitive, otherwise delegate to variableTypeToString, which renders an
 *  effect-set union as `<...>` and a type-alias reference by name. Single
 *  source of truth for rendering a raises clause (AgencyGenerator delegates
 *  here). */
export function effectSetToSource(
  type: VariableType,
  typeAliases: Record<string, VariableType>,
  hooks?: TypePrintHooks,
): string {
  if (type.type === "primitiveType" && type.value === "any") return "<*>";
  return variableTypeToString(type, typeAliases, true, hooks);
}

export type TypePrintHooks = {
  objectType?: (
    objectType: ObjectType,
    printChild: (child: VariableType) => string,
  ) => string | undefined;
};

function objectTypeToString(
  objectType: ObjectType,
  printChild: (child: VariableType) => string,
  hooks?: TypePrintHooks,
): string {
  const rendered = hooks?.objectType?.(objectType, printChild);
  if (rendered !== undefined) {
    return rendered;
  }
  const props = objectType.properties
    .map((prop) => `${prop.key}: ${printChild(prop.value)}`)
    .join("; ");
  return `{ ${props} }`;
}

export function variableTypeToString(
  variableType: VariableType,
  typeAliases: Record<string, VariableType>,
  forFormatting: boolean = false,
  hooks?: TypePrintHooks,
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
    // Recursively build array type string. Parenthesize a union element so
    // `(a | b)[]` does not render as the ambiguous `a | b[]` (which reads as
    // `a | (b[])`).
    const inner = variableTypeToString(
      variableType.elementType,
      typeAliases,
      forFormatting,
      hooks,
    );
    if (
      variableType.elementType.type === "unionType" ||
      variableType.elementType.type === "keyofType" ||
      variableType.elementType.type === "intersectionType"
    ) {
      // keyof parenthesizes for the same re-parse reason as unions:
      // `keyof User[]` reads as keyof (User[]).
      return `(${inner})[]`;
    }
    return `${inner}[]`;
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
        .map((t) => effectSetMemberToSource(t, typeAliases, hooks))
        .join(", ");
      return `<${members}>`;
    }
    const str = variableType.types
      .map((t) => variableTypeToString(t, typeAliases, forFormatting, hooks))
      .join(" | ");
    if (str.length > MAX_LENGTH) {
      const arr = str.split(" | ");
      return "\n  | " + arr.join("\n  | ");
    }
    return str;
  } else if (variableType.type === "objectType") {
    return objectTypeToString(
      variableType,
      (child) => variableTypeToString(child, typeAliases, forFormatting, hooks),
      hooks,
    );
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
          hooks,
        );
        return p.name ? `${p.name}: ${t}` : t;
      })
      .join(", ");
    const ret = variableTypeToString(
      variableType.returnType,
      typeAliases,
      forFormatting,
      hooks,
    );
    // `raises` is Agency-only surface syntax; never emit it into TS codegen (`=>`).
    const raisesStr =
      forFormatting && variableType.raises
        ? ` raises ${effectSetToSource(variableType.raises, typeAliases, hooks)}`
        : "";
    return `(${params}) ${arrow} ${ret}${raisesStr}`;
  } else if (variableType.type === "resultType") {
    const s = variableTypeToString(
      variableType.successType,
      typeAliases,
      forFormatting,
      hooks,
    );
    const f = variableTypeToString(
      variableType.failureType,
      typeAliases,
      forFormatting,
      hooks,
    );
    if (s === "any" && f === "any") return "Result";
    if (f === "string") return `Result<${s}>`;
    return `Result<${s}, ${f}>`;
  } else if (variableType.type === "genericType") {
    const args = variableType.typeArgs
      .map((a) => variableTypeToString(a, typeAliases, forFormatting, hooks))
      .join(", ");
    return `${variableType.name}<${args}>${formatValueArgs(variableType.valueArgs)}`;
  } else if (variableType.type === "intersectionType") {
    return variableType.types
      .map((m) => {
        const s = variableTypeToString(m, typeAliases, forFormatting, hooks);
        return m.type === "unionType" ? `(${s})` : s;
      })
      .join(" & ");
  } else if (variableType.type === "keyofType") {
    const op = variableTypeToString(
      variableType.operand,
      typeAliases,
      forFormatting,
      hooks,
    );
    // Parenthesize union AND intersection operands: `keyof (A | B)` /
    // `keyof (A & B)` must not print bare (wrong re-parse precedence).
    return variableType.operand.type === "unionType" ||
      variableType.operand.type === "intersectionType"
      ? `keyof (${op})`
      : `keyof ${op}`;
  } else if (variableType.type === "indexedAccessType") {
    const obj = variableTypeToString(
      variableType.objectType,
      typeAliases,
      forFormatting,
      hooks,
    );
    const wrapped =
      variableType.objectType.type === "keyofType" ||
      variableType.objectType.type === "unionType" ||
      variableType.objectType.type === "intersectionType"
        ? `(${obj})`
        : obj;
    const index = variableTypeToString(
      variableType.index,
      typeAliases,
      forFormatting,
      hooks,
    );
    return `${wrapped}[${index}]`;
  }
  return "unknown";
}
