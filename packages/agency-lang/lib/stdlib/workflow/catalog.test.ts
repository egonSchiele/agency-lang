import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgencyFunction, type FuncParam } from "../../runtime/agencyFunction.js";
import { catalogEntries } from "./catalog.js";
import { signatureKey } from "./resolve.js";
import type { Signature } from "./types.js";

const param = (name: string): FuncParam => ({
  name,
  hasDefault: false,
  defaultValue: undefined,
  variadic: false,
});

/** searchNotes(query, each), where `each` is a block, so the schema leaves it out. */
const searchNotes = AgencyFunction.create(
  {
    name: "searchNotes",
    module: "agent/notes.agency",
    fn: (_run, query: string) => [query],
    params: [param("query"), param("each")],
    toolDefinition: {
      name: "searchNotes",
      description: "Find notes.",
      schema: z.object({ query: z.string() }),
    },
  },
  {},
);

const searchSignature: Signature = {
  signature: "def searchNotes(query: string, each: (string) -> any): Result<Note[]>",
  returnType: "Result<Note[]>",
  returnsResult: true,
  docstring:
    "Find notes whose title matches the query.\n\n  @param query - Text to match\n  @param each - Called once per note\n  @param querry - A misspelled entry",
  params: [
    { name: "query", type: "string", default: null, description: "Text to match" },
    { name: "each", type: "(string) -> any", default: null, description: "Called once per note" },
  ],
};

const ref = { module: "./notes.agency", name: "searchNotes" };
const signatures = { [signatureKey(ref.module, ref.name)]: searchSignature };

describe("catalogEntries", () => {
  it("builds an entry from the signature and the parameter schema, leaving out a block and every @param entry", () => {
    expect(catalogEntries([searchNotes], [ref], signatures)).toEqual([
      {
        module: "./notes.agency",
        name: "searchNotes",
        description: "Find notes whose title matches the query.",
        params: [
          {
            name: "query",
            type: "string",
            default: null,
            description: "Text to match",
            schema: { type: "string" },
          },
        ],
        returns: "Result<Note[]>",
      },
    ]);
  });

  it("gives a tool with no docstring an empty description", () => {
    const bare: Signature = {
      ...searchSignature,
      docstring: null,
      params: searchSignature.params.map((param) => ({ ...param, description: null })),
    };
    const [entry] = catalogEntries([searchNotes], [ref], {
      [signatureKey(ref.module, ref.name)]: bare,
    });
    expect([entry.description, entry.params[0].description]).toEqual(["", null]);
  });
});
