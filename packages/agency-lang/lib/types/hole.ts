import { SourceLocation } from "./base.js";
import { VariableType } from "./typeHints.js";

/** The syntactic category of thing that can fill a hole. Determined by the
 *  hole's position; never written by the user. */
export type HoleSort = "expr" | "statements" | "identifier" | "decl";

/** A gap in a template. A program containing one cannot be compiled or run;
 *  it must be loaded with loadTemplate and filled first. */
export type Hole = {
  type: "hole";
  name: string;
  sort: HoleSort;
  /** True for `#...name`, which expands to a sequence rather than one item. */
  splice: boolean;
  typeAnnotation?: VariableType;
  loc: SourceLocation;
};

export function isHole(value: unknown): value is Hole {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: string }).type === "hole"
  );
}

/**
 * The declared name at a site that can hold an identifier hole (a function
 * name, node name, or import specifier). In a compilable program these are
 * always strings. A template's hole reads back as its printed form, `#name`
 * — safe as a registry or display key because `#` cannot appear in a user
 * identifier, and codegen is unreachable for templates (AG8001 refuses
 * first).
 */
export function declaredName(value: string | Hole): string {
  if (typeof value === "string") return value;
  return `#${value.name}`;
}
