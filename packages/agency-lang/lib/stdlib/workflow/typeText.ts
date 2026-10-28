/**
 * Type text a workflow carries (`inputs`, and an LLM step's `output`), parsed
 * once with the real type parser. Parse uses this to check the text and to
 * read the input names; render uses it to print the declaration. Both see
 * the same parse, so a name parse accepts is a name render writes.
 */
import { AgencyGenerator } from "../../backends/agencyGenerator.js";
import type { AgencyNode, TypeAlias } from "../../types.js";
import { _parseAST } from "../agency.js";

export type TypeTextResult = { alias: TypeAlias } | { message: string };

/** Parsing records a blank line as a node; it is not a declaration. */
const IGNORED_NODES = ["newLine"];

function nodesOf(node: unknown): unknown[] {
  if (Array.isArray(node)) {
    return node.flatMap(nodesOf);
  }
  if (typeof node !== "object" || node === null) {
    return [];
  }
  return [node, ...Object.values(node).flatMap(nodesOf)];
}

/** True when any node inside a parsed type carries a `@validate` or
 *  `@jsonSchema` tag. */
function carriesTags(type: unknown): boolean {
  return nodesOf(type).some((node) => {
    const tags = (node as { tags?: unknown }).tags;
    return Array.isArray(tags) && tags.length > 0;
  });
}

/**
 * The type alias `type <name> = <text>` declares, or the problem with the
 * text. `field` names the workflow field in messages. An `inputs` type must
 * be an object type. The text may not carry a tag: a `@validate` names a
 * function the generated program would call, and a `@jsonSchema` is data the
 * program would carry, and neither is something a workflow should choose.
 */
export function parseTypeText(name: string, text: string, field: string): TypeTextResult {
  const shape = field === "inputs" ? "one object type" : "one type";
  let nodes: AgencyNode[];
  try {
    nodes = _parseAST(`type ${name} = ${text}`).nodes;
  } catch (error) {
    return { message: `${field} must be ${shape}: ${(error as Error).message}` };
  }
  const declarations = nodes.filter((node) => !IGNORED_NODES.includes(node.type));
  const [alias] = declarations;
  if (declarations.length !== 1 || alias.type !== "typeAlias" || alias.aliasName !== name) {
    return { message: `${field} must be ${shape}` };
  }
  if (field === "inputs" && alias.aliasedType.type !== "objectType") {
    return { message: `${field} must be ${shape}` };
  }
  if (carriesTags(alias.aliasedType) || (alias.tags ?? []).length > 0) {
    return { message: `a type in ${field} may not carry @validate or @jsonSchema tags` };
  }
  return { alias };
}

/** The top-level property names of an `inputs` object type, or none when
 *  the text is not one. Nested property names are not inputs. */
export function inputNames(text: string): string[] {
  const parsed = parseTypeText("Inputs", text, "inputs");
  if ("message" in parsed || parsed.alias.aliasedType.type !== "objectType") {
    return [];
  }
  return parsed.alias.aliasedType.properties.map((property) => property.key);
}

/** The declaration line, printed by the printer `describe` uses. */
export function printType(alias: TypeAlias): string {
  return new AgencyGenerator().signatureOf(alias);
}
