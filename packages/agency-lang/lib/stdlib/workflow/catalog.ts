/**
 * The catalog of tools a workflow may call, for a GUI's tool picker or a
 * person writing a workflow by hand. Each entry joins two sources: what
 * `describe` says about the tool's module, and the JSON Schema the tool's
 * function value sends a model for each parameter.
 */
import { AgencyFunction } from "../../runtime/agencyFunction.js";
import { withoutParamDocs } from "../../utils/paramDocs.js";
import type { ExportParam } from "../agency.js";
import { signatureKey } from "./resolve.js";
import type { Signature, ToolRef } from "./types.js";

/** One parameter a workflow step can pass to a tool. */
export type CatalogParam = ExportParam & { schema: unknown };

/** One tool a workflow may call. `module` is what a step's `module` field
 *  says. `returns` is null when the tool declares no return type. */
export type CatalogEntry = {
  module: string;
  name: string;
  description: string;
  params: CatalogParam[];
  returns: string | null;
  /** The JSON Schema of the value a reference into this tool's step reads:
   *  the declared return type, or the success type inside a `Result`. Null
   *  when the tool declares no return type or returns a function. */
  returnSchema: unknown | null;
  /** What the tool can raise, as `describe` reports it. A tool that uses
   *  `guard` lists `std::guard`. `stepEffects` leaves it out, since a guard
   *  trip is a question about budget, not a permission. */
  effects: string[];
};

/** The JSON Schema of each parameter in the tool's definition, by name.
 *  A function-typed parameter is not in the definition. */
function parameterSchemas(tool: unknown): Record<string, unknown> {
  if (!AgencyFunction.isAgencyFunction(tool)) {
    return {};
  }
  const schema = tool.toolDefinition?.schema as { toJSONSchema?: () => unknown } | null;
  if (typeof schema?.toJSONSchema !== "function") {
    return {};
  }
  const json = schema.toJSONSchema() as { properties?: Record<string, unknown> };
  return json.properties ?? {};
}

/** The JSON Schema of what the tool returns, from the zod schema the
 *  compiler emitted for its return type. */
function returnSchemaOf(tool: unknown): unknown | null {
  if (!AgencyFunction.isAgencyFunction(tool)) {
    return null;
  }
  const schema = tool.returnSchema as { toJSONSchema?: () => unknown } | null;
  if (typeof schema?.toJSONSchema !== "function") {
    return null;
  }
  return schema.toJSONSchema();
}

function catalogEntry(tool: unknown, ref: ToolRef, signature: Signature): CatalogEntry {
  const schemas = parameterSchemas(tool);
  const params = signature.params
    .filter((param) => Object.hasOwn(schemas, param.name))
    .map((param) => ({ ...param, schema: schemas[param.name] }));
  const description =
    signature.docstring === null ? "" : withoutParamDocs(signature.docstring).trim();
  return {
    module: ref.module,
    name: ref.name,
    description,
    params,
    returns: signature.returnType,
    returnSchema: returnSchemaOf(tool),
    effects: signature.effects,
  };
}

/** One entry per ref. `toolRefs` returns one ref per tool, in the tool
 *  list's order, so `refs[i]` and `tools[i]` describe the same tool. */
export function catalogEntries(
  tools: unknown[],
  refs: ToolRef[],
  signatures: Record<string, Signature>,
): CatalogEntry[] {
  return refs.map((ref, index) =>
    catalogEntry(tools[index], ref, signatures[signatureKey(ref.module, ref.name)]),
  );
}
