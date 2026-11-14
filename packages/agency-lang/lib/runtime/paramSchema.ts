import type { z } from "zod";

/**
 * Finish one argument of a tool's schema. Generated code calls this for an
 * argument that has a `@param` line in the docstring, a default, or both.
 *
 * The description the model sees on the argument is, in order: the `@param`
 * text, the description a `@jsonSchema` tag put on the type, and the
 * default. An argument with a default is optional in the schema, so the
 * model may leave it out, and accepts null, which the call treats the same.
 */
export function __paramSchema(
  schema: z.ZodType,
  doc: string | null,
  defaultText: string | null,
  addNullable: boolean,
): z.ZodType {
  const own = schema.meta()?.description;
  const text = [doc, own].filter((part) => typeof part === "string" && part !== "").join("\n");
  const description = defaultText === null ? text : joinDefault(text, defaultText);
  const nullable = addNullable ? schema.nullable() : schema;
  // The description goes on before `.optional()`. On the optional wrapper,
  // zod writes `description` ahead of `anyOf`, and a schema rebuilt from
  // its JSON Schema (a learned tool's, in the parent process) writes it
  // after, so the two would not compare equal.
  const described =
    description === "" ? nullable : nullable.meta({ ...(nullable.meta() ?? {}), description });
  return defaultText === null ? described : described.optional();
}

function joinDefault(text: string, defaultText: string): string {
  if (text === "") {
    return `Default: ${defaultText}`;
  }
  const stop = /[.!?]$/.test(text) ? "" : ".";
  return `${text}${stop} Default: ${defaultText}`;
}
