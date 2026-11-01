# ADI-252: `catalog`, the tools a workflow may call — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The owner prefers one agent working inline, so do not use subagent-driven development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `catalog(tools, dir)` in `std::workflow` returns one entry per tool the host passed, with the tool's module, name, description, return type, and each parameter's name, type, default, description, and JSON Schema.

**Architecture:** The catalog is built from the two sources the workflow generator already reads. `describe` reads the tool's module source and gives the description and the return type. This plan makes it give each parameter's type, default, and `@param` text as well. The tool's function value gives the JSON Schema of each parameter, which is what the tool loop sends to a model. `catalog` reuses `_toolRefs` and `_signatures`, the same two steps `checkWorkflow` starts with, so it refuses the same tool lists and raises the same `std::read` prompts.

**Tech Stack:** TypeScript in `lib/runtime/`, `lib/stdlib/`, and `lib/backends/agencyGenerator.ts`; Agency in `stdlib/agency.agency` and `stdlib/workflow.agency`; vitest; one Agency execution test.

**Spec:** `docs/superpowers/specs/2026-10-26-workflows-design.md`, sections "The catalog", "Public API", and "Left to the builder". Linear ticket ADI-252. Read `docs/dev/stdlib/workflow.md` before starting.

## Background for someone new to this codebase

### What the catalog is for

A workflow step names a tool and passes it arguments by name:

```json
{ "id": "note", "kind": "tool", "module": "./notes.agency", "tool": "searchNotes",
  "args": { "query": { "$ref": "inputs.noteTitle" } } }
```

To write that step, a person or a program has to know which tools there are, what each one's module is called, what arguments it takes, and what it returns. The catalog answers those questions. The `agency workflow` TUI (ADI-255) will show it as a tool picker. A GUI, such as BMO's builder, will read it to fill a dropdown and to know that `searchNotes` returns `Result<Note[]>`. A person writing a workflow by hand can print it.

Here is the entry this plan produces for `round` from `std::math`:

```json
{
  "module": "std::math",
  "name": "round",
  "description": "Round a number to a given number of decimal places. With no precision it\n  rounds to a whole number.",
  "params": [
    { "name": "num", "type": "number", "default": null,
      "description": "The number to round", "schema": { "type": "number" } },
    { "name": "precision", "type": "number", "default": "0",
      "description": "The number of decimal places. Defaults to 0.",
      "schema": { "anyOf": [{ "type": "number" }, { "type": "null" }], "description": "Default: 0" } }
  ],
  "returns": "number"
}
```

`module` is exactly what a step's `module` field must say. `type`, `default`, and `returns` are Agency text, written the way the tool's signature writes them. `schema` is the JSON Schema a model sees for that parameter.

### Where each piece of the entry comes from today

**`describe`** (`_describe` in `lib/stdlib/agency.ts:241`, exported as `describe` from `stdlib/agency.agency:909`) parses a module's source and returns one `ExportInfo` per export. For a def it has the name, the whole signature as one string, the declared return type on its own (`returnType`), whether it returns a `Result` (`returnsResult`), and the docstring as text (`localExportInfos`, `lib/stdlib/agency.ts:334-380`). It has nothing per parameter. The parameter types are inside the `signature` string, and the spec's decision 15 says no caller re-parses a signature string. So this plan adds a `params` list to `ExportInfo`, printed from the AST the same way the signature is printed.

**The tool's function value.** Every Agency `def` compiles to an `AgencyFunction` whose `toolDefinition.schema` is a zod object with one entry per parameter (`buildToolDefinition`, `lib/backends/typescriptBuilder.ts:2136`). The tool loop sends that object to the model as it is (`lib/runtime/prompt.ts:553-561`), and the MCP adapter sends `schema.toJSONSchema()` as a tool's input schema (`lib/serve/mcp/adapter.ts:49-56`). On a current build, `toJSONSchema()` for `round` gives this:

```json
{ "type": "object",
  "properties": { "num": { "type": "number" },
                  "precision": { "anyOf": [{ "type": "number" }, { "type": "null" }], "description": "Default: 0" } },
  "required": ["num", "precision"], "additionalProperties": false }
```

A parameter with a default becomes nullable and gets the description `Default: <value>` (`paramSchemaContribution`, `typescriptBuilder.ts:2085-2123`). A function-typed parameter, such as a block, is left out of the schema entirely, because a model cannot pass a function. A workflow step cannot pass one either, because its arguments are JSON values.

**`@param` lines.** A docstring describes its parameters with `@param name - text` lines. The format is documented for users in `docs/site/guide/partial-application.md:51-64`. The one reader of those lines today is `stripBoundParams` in `lib/runtime/stripBoundParams.ts`, which removes the entries of bound parameters from a partial's description. Its rule: an entry starts at a line matching `^\s*@param\s+(\w+)`, continues over the non-blank lines after it, and ends at the next `@param` line or at a blank line. The dash after the name is optional. Nine tests in `lib/runtime/stripBoundParams.test.ts` pin that rule. This plan reads parameter descriptions with the same rule, through one shared splitter, so the two readers cannot drift apart.

**How the workflow generator reads tools.** `checkWorkflow` starts with two steps that the catalog reuses:

1. `_toolRefs(tools, dir)` (`lib/stdlib/workflow/index.ts:69`, logic in `tools.ts`) turns each function value into a `ToolRef`, `{ module, name }`, where `module` is the text an import line uses: `std::math`, or `./notes.agency` relative to `dir`. It refuses a partial, a renamed function, a `createTool` tool, a runtime builtin, a package tool, a file outside `dir`, and two tools with one name, and it reports every problem at once as a `WorkflowFailure`, `{ problems }`. It returns one ref per tool, in the tool list's order.
2. `_signatures(refs, dir)` (`stdlib/workflow.agency:131`) calls `describe` once per module. For a `std::` module it describes a re-export line, which raises nothing. For a local module it reads the file with `read`, which raises `std::read`. `_pickSignatures` (`index.ts:99`) keeps four fields per tool in a `Signature` (`types.ts:93`), keyed by `signatureKey(module, name)` (`resolve.ts:84`).

`_compileWithRanges` turns a failed read into a new failure with `_workflowFailure(signatures.error)` (`stdlib/workflow.agency:165`). That drops the failure's `rejected` flag, so a rejected `std::read` reaches a model as an ordinary error. That is a known bug, to be fixed in its own ticket. The catalog passes a failed read through unchanged, so it does not repeat the bug.

### Build and test commands

- After editing `stdlib/*.agency`, run `make > /tmp/adi252-make.log 2>&1`. It rebuilds the stdlib and regenerates `docs/site/stdlib/*.md`. Never edit those pages by hand.
- Unit tests: `pnpm test:run <files> > /tmp/adi252-unit.log 2>&1`, then read the file.
- One Agency test: `pnpm run agency test tests/agency/workflow/catalog.test.json > /tmp/adi252-agency.log 2>&1`.
- Before each commit: `pnpm run typecheck`, and `npx prettier --write` on the TypeScript files you changed. Do not run `pnpm run fmt:ts`, which formats every worktree under the package.

## Global Constraints

- The public signature is the spec's: `catalog(tools: any[], dir: string = ""): Result<CatalogEntry[]>`.
- `CatalogEntry` has exactly the spec's fields: `module`, `name`, `description`, `params`, `returns`. `returns` is `string | null`, as call 4 below explains.
- Every tool `catalog` lists is one `checkWorkflow` would accept, because both start from `_toolRefs` and `_signatures`. The catalog adds no rule of its own about which tools are allowed.
- `catalog` raises exactly what those two steps raise: one `std::read` per local module, and nothing for a `std::` module. It declares no new effect.
- The change to `describe` is additive. No existing `ExportInfo` field changes value.
- One reader of `@param` entries. `stripBoundParams` and the new reader share one splitter, and the existing `stripBoundParams` tests pass unchanged.

## Calls I made

Each is a place the spec or the ticket leaves open. The owner can object to any of them.

1. **The shape of `CatalogParam`.** The spec leaves it to the builder, "following what the tool loop already builds per parameter". It is `{ name, type, default, description, schema }`:
   - `schema` is what the tool loop builds per parameter: that parameter's entry in the tool's JSON Schema.
   - `type` is the declared type as Agency text, such as `string[]` or `Note`, or null when none is declared. A person reads Agency text, and `returns` is Agency text, so a reader can compare one tool's `returns` with another tool's parameter `type` directly.
   - `default` is the default as Agency source, such as `0` or `null`. It is null when the parameter has no default, which means a step must pass a value. The parser reads `b?: number` as type `number | null` with default `null`, so the catalog shows that type and that default.
   - `description` is the text of the docstring's `@param` entry for that parameter, or null.
2. **`describe` gains `params`.** `ExportInfo` gets `params: ExportParam[]`, where `ExportParam` is `{ name, type, default, description }`, for every def and node. Other kinds get an empty list. The type text comes from the AST, through the printer the signature uses, so the catalog never parses a signature string. Any other generator that reads `describe` gets the parameters too.
3. **A parameter the tool's schema leaves out is left out of the catalog.** That is a function-typed parameter, such as a block. A step's arguments are JSON values, so a workflow cannot pass one. A tool with a required function-typed parameter still appears, and `checkWorkflow` reports a step that calls it.
4. **`returns` is `string | null`, not `string`.** It is `describe`'s `returnType`, which is null when the tool declares no return type. An empty string would look like a type with no name. The spec's Public API changes to match.
5. **An entry's `description` is the docstring without its `@param` entries,** trimmed, or the empty string when the tool has no docstring. Each parameter carries its own description, so keeping the entries would say each one twice.
6. **How `catalog` fails.** A tool list `_toolRefs` refuses fails with every problem as `{ problems }` data, the way `checkWorkflow` fails. A failed module read is returned as it came, so a rejected `std::read` keeps `rejected: true`.
7. **Entries follow the tool list's order.** `_signatures` groups tools by module and sorts them. The catalog reads signatures by key, so the order the host chose is kept.

## Not in this ticket

- `returns` names an alias such as `Note` without its fields. A GUI that wants to offer `note[0].id` as a wire endpoint needs `Note`'s fields. `describe` already returns the module's exported type aliases, so a later change can add them to the catalog. Nothing is built for it now.
- The tool's effects. `describe` has them, and a GUI could show "this tool asks before it writes". The spec's entry has no field for them.

## Review Focus

These are the inputs the spec implies but no test in the ticket exercises. Each one gets a test in the task named.

1. A local module read the user rejects: `catalog` fails, and the failure keeps `rejected: true`. (Task 4)
2. A tool with a block parameter: the block is left out of `params`. (Task 3)
3. A tool with no docstring: its description is the empty string, and each parameter's description is null. (Task 3)
4. An `@param` entry with no dash, or one that runs over two lines: read as `stripBoundParams` reads it. (Task 1)
5. An optional parameter `b?: number`: type `number | null`, default `null`. (Task 2)

---

### Task 1: One reader for `@param` entries

**Files:**
- Rename: `lib/runtime/stripBoundParams.ts` to `lib/runtime/paramDocs.ts`, and `lib/runtime/stripBoundParams.test.ts` to `lib/runtime/paramDocs.test.ts`, with `git mv`
- Modify: `lib/runtime/agencyFunction.ts` (the import of `stripBoundParams`, line 4)

**Interfaces:**
- Produces, from `lib/runtime/paramDocs.ts`:
  - `type ParamDoc = { name: string; text: string }`
  - `paramDocs(description: string): ParamDoc[]`: every `@param` entry, in order. `text` is the rest of the entry's first line after the name, with one leading `-` and the whitespace around it removed, then each continuation line trimmed, all joined by one space and trimmed. An entry with nothing after its name has the text `""`.
  - `stripBoundParams(description: string, boundParamNames: string[]): string`, with the behavior it has today.

- [ ] **Step 1: Move the file and its tests**

`git mv` both files, and change the import in `agencyFunction.ts`. Run the moved tests to confirm the move changed nothing: `pnpm test:run lib/runtime/paramDocs.test.ts > /tmp/adi252-t1.log 2>&1`. All nine pass.

- [ ] **Step 2: Write the failing tests**

Add to `paramDocs.test.ts`:

```ts
describe("paramDocs", () => {
  it("reads each entry's name and text, in order, with or without the dash", () => {
    const description = `Read a file.
@param dir - The directory
@param filename The file name`;
    expect(paramDocs(description)).toEqual([
      { name: "dir", text: "The directory" },
      { name: "filename", text: "The file name" },
    ]);
  });

  it("joins an entry's continuation lines with a space, up to a blank line", () => {
    const description = `Read a file.
  @param dir - The directory to read from.
      Must be an absolute path.

See also: writeFile`;
    expect(paramDocs(description)).toEqual([
      { name: "dir", text: "The directory to read from. Must be an absolute path." },
    ]);
  });

  it("gives an empty text to an entry with nothing after its name", () => {
    expect(paramDocs("@param flag")).toEqual([{ name: "flag", text: "" }]);
  });

  it("finds no entries in a description without @param lines", () => {
    expect(paramDocs("Read a file from a directory.")).toEqual([]);
  });
});
```

Run the file. The four new tests fail because `paramDocs` does not exist.

- [ ] **Step 3: Implement the splitter, then both readers over it**

Write one private function, `docSections(description: string): DocSection[]`, with `type DocSection = { param: string | null; lines: string[] }`. It walks the lines once. A `@param` line opens a section for its name. Each following line that is neither blank nor a `@param` line joins that section. A blank line closes the section and joins it as its last line. Every other line is a section of its own with `param: null`.

Then `stripBoundParams` keeps the sections whose `param` is null or not bound and joins their lines with `\n`. A blank line that closes a bound entry goes with it, which is what the existing test "until blank line, preserving the blank line" pins. `paramDocs` maps each section that has a `param` to its `ParamDoc`.

Drop `stripBoundParams`'s early return. With the splitter, an empty description and a list of no bound names both come back unchanged, and the two existing tests for those cases check it.

- [ ] **Step 4: Run the tests, typecheck, commit**

Run `paramDocs.test.ts` and `lib/runtime/agencyFunction.test.ts`, which covers `.partial()` stripping descriptions. All pass. Then `pnpm run typecheck`, prettier on the three files, and commit with the message in a file: `paramDocs: one reader for a docstring's @param entries`.

---

### Task 2: `describe` reports each parameter

**Files:**
- Modify: `lib/backends/agencyGenerator.ts` (two public methods, and `renderParams` at line 746 uses them)
- Modify: `lib/cli/doc.ts` (`formatDefaultValue` at line 550 uses the new default printer)
- Modify: `lib/stdlib/agency.ts` (`ExportParam`, `ExportInfo.params`, `localExportInfos`, and the entries for types, consts, and thin re-exports)
- Modify: `stdlib/agency.agency` (the Agency types `ExportParam` and `ExportInfo`, and `describe`'s docstring)
- Test: `lib/stdlib/agency.test.ts`, beside the existing `describe("_describe (reify)")` block at line 563

**Interfaces:**
- Consumes: `paramDocs` from Task 1.
- Produces:
  - On `AgencyGenerator`: `paramTypeOf(param: FunctionParameter): string | null` and `paramDefaultOf(param: FunctionParameter): string | null`. These print the type and the default exactly as `signatureOf` prints them inside a signature, in the display form. Each returns null when the parameter has no declared type or no default.
  - In `lib/stdlib/agency.ts`: `export type ExportParam = { name: string; type: string | null; default: string | null; description: string | null }`, and `ExportInfo.params: ExportParam[]`.
  - In `stdlib/agency.agency`: the same `ExportParam` type with a doc comment on each field, and `params: ExportParam[]` on `ExportInfo`, documented as "Each parameter of a def or node; empty for every other kind, and for a re-export that cannot be read from a source string."

- [ ] **Step 1: Write the failing tests**

Add to `agency.test.ts`:

```ts
describe("_describe: parameters", () => {
  const source = `export def fetchPage(url: string, raw, retries: number = 3, note?: string) {
  """
  Fetch a page.

  @param url - The page to fetch
  @param retries The number of tries.
      Zero means one try.
  """
  return url
}

export node main(name: string) {
  return name
}

export type Page = { url: string }
`;

  it("lists each parameter's name, type, default, and @param text", () => {
    expect(_describe(source).exports[0].params).toEqual([
      { name: "url", type: "string", default: null, description: "The page to fetch" },
      { name: "raw", type: null, default: null, description: null },
      {
        name: "retries",
        type: "number",
        default: "3",
        description: "The number of tries. Zero means one try.",
      },
      { name: "note", type: "string | null", default: "null", description: null },
    ]);
  });

  it("lists a node's parameters and gives other kinds an empty list", () => {
    const rows = _describe(source).exports.map((entry) => [
      entry.name,
      entry.params.map((param) => param.name),
    ]);
    expect(rows).toEqual([
      ["fetchPage", ["url", "raw", "retries", "note"]],
      ["main", ["name"]],
      ["Page", []],
    ]);
  });

  it("carries a std:: re-export's parameters", () => {
    const info = _describe('export { round } from "std::math"');
    expect(info.exports[0].params.map((param) => [param.name, param.default])).toEqual([
      ["num", null],
      ["precision", "0"],
    ]);
  });
});
```

The parser refuses a parameter without a default after one with a default, so `raw` comes second. On a current build, `describe` prints this signature as `fetchPage(url: string, raw, retries: number = 3, note: string | null = null)`, which is where the expected `type` and `default` text comes from.

Run the file. The three tests fail because `params` is undefined.

- [ ] **Step 2: Add the two printers to `AgencyGenerator`**

`paramTypeOf` returns `this.renderType(param.typeHint, "display")` when the parameter has a type hint. `paramDefaultOf` returns `this.processNode(param.defaultValue).trim()` when it has a default. Change `renderParams` to call both, so the signature and `describe` cannot print a parameter two ways.

In `lib/cli/doc.ts`, replace `formatDefaultValue(node)` with a call to `generator.paramDefaultOf(param) ?? ""`. Its one caller, `generateParamTable`, then passes the parameter itself rather than `p.defaultValue`.

- [ ] **Step 3: Add `params` to `describe`**

In `lib/stdlib/agency.ts`, write `exportParams(node: FunctionDefinition | GraphNodeDefinition, generator: AgencyGenerator, docstring: string | null): ExportParam[]`. It maps `node.parameters` to `ExportParam`s. `description` is the text of the first `paramDocs(docstring)` entry with the parameter's name, or null when there is none or its text is empty. In `localExportInfos`, compute the docstring text once for the def entry and once for the node entry, and pass that one value to both the entry's `docstring` field and `exportParams`. Give every other entry `params: []`: the type alias and const entries near `agency.ts:389` and `:413`, and the thin re-export at `:525`. A `std::` re-export is described from its source module, so it gets the source's parameters with no change.

In `stdlib/agency.agency`, add the `ExportParam` type and the `params` field, and add one sentence to `describe`'s docstring: "Each def and node lists its parameters, with the type and default as the signature writes them and the text of its `@param` entry."

- [ ] **Step 4: Build, run, commit**

`make`, then run `lib/stdlib/agency.test.ts`, `lib/backends/signatureOf.test.ts`, and `lib/cli/doc.test.ts`. All pass, and the generated doc pages do not change: `git status docs/site` shows only `docs/site/stdlib/agency.md`, which now lists `ExportParam`. Typecheck, prettier, and commit: `describe: report each parameter's type, default, and @param text`.

---

### Task 3: Catalog entries from signatures and parameter schemas

**Files:**
- Modify: `lib/stdlib/workflow/types.ts` (`Signature` gains `params`)
- Modify: `lib/stdlib/workflow/index.ts` (`_pickSignatures` copies `params`, and a new `_catalogEntries`)
- Create: `lib/stdlib/workflow/catalog.ts`
- Create: `lib/stdlib/workflow/catalog.test.ts`
- Modify: every `Signature` literal in `lib/stdlib/workflow/*.test.ts` and `testFixtures.ts`, about a dozen, which each gain `params: []`

**Interfaces:**
- Consumes: `ExportParam` from Task 2.
- Produces:
  - `Signature.params: ExportParam[]`.
  - In `catalog.ts`: `type CatalogParam = ExportParam & { schema: unknown }`, `type CatalogEntry = { module: string; name: string; description: string; params: CatalogParam[]; returns: string | null }`, and `catalogEntries(tools: unknown[], refs: ToolRef[], signatures: Record<string, Signature>): CatalogEntry[]`.
  - In `index.ts`: `_catalogEntries`, with the same signature, re-exported for `stdlib/workflow.agency`.
  - `catalogEntries` makes one entry per ref, in the refs' order, which is the tool list's order. It pairs each ref with the tool of the same name. Names are unique, because `_toolRefs` refuses a repeated name.

- [ ] **Step 1: Write the failing tests**

`catalog.test.ts`:

```ts
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
    "Find notes whose title matches the query.\n\n  @param query - Text to match\n  @param each - Called once per note",
  params: [
    { name: "query", type: "string", default: null, description: "Text to match" },
    { name: "each", type: "(string) -> any", default: null, description: "Called once per note" },
  ],
};

const ref = { module: "./notes.agency", name: "searchNotes" };
const signatures = { [signatureKey(ref.module, ref.name)]: searchSignature };

describe("catalogEntries", () => {
  it("builds an entry from the signature and the parameter schema, leaving out a block", () => {
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
```

Run it. Both fail because `catalog.ts` does not exist.

- [ ] **Step 2: Carry `params` through `_pickSignatures`**

Add `params: ExportParam[]` to `Signature` in `types.ts`, with the comment "What `describe` says about each parameter." In `_pickSignatures`, copy `params` with the other four fields. Add `params: []` to each `Signature` literal in the workflow tests, including the `exportInfo` helper and the expected value in `index.test.ts:135-160`, and the `signature` helper in `testFixtures.ts:95`. Run `pnpm test:run lib/stdlib/workflow/` and confirm everything except `catalog.test.ts` passes.

- [ ] **Step 3: Implement `catalogEntries`**

For each ref, take the tool with the same name, and look up the signature by `signatureKey(ref.module, ref.name)`. Read the tool's parameter schemas once with a small helper, `parameterSchemas(tool: unknown): Record<string, unknown>`. It returns the `properties` of `toolDefinition.schema.toJSONSchema()`, or `{}` for a value with no zod tool definition. Then:

- `params` is the signature's params that appear in that record, each with its `schema` added, in the signature's order.
- `description` is `stripBoundParams(docstring, names).trim()`, where `names` is the name of every parameter in the signature, block parameters included. It is `""` when the docstring is null.
- `module` and `name` come from the ref, and `returns` is the signature's `returnType`.

Re-export it from `index.ts` as `_catalogEntries`.

- [ ] **Step 4: Run, typecheck, commit**

Run `pnpm test:run lib/stdlib/workflow/`. Everything passes. Typecheck, prettier, and commit: `std::workflow: catalog entries from signatures and parameter schemas`.

---

### Task 4: `catalog` in `std::workflow`

**Files:**
- Modify: `stdlib/workflow.agency` (two types, the function, the import of `_catalogEntries`, and one sentence in the module doc comment)
- Create: `tests/agency/workflow/catalog.agency` and `tests/agency/workflow/catalog.test.json`

**Interfaces:**
- Consumes: `_toolRefs`, `_signatures`, and `_catalogEntries`.
- Produces:

```
/** One parameter a workflow step can pass to a tool. */
export type CatalogParam = {
  name: string;
  type: string | null;
  default: string | null;
  description: string | null;
  schema: Json
}

/** One tool a workflow may call. */
export type CatalogEntry = {
  module: string;
  name: string;
  description: string;
  params: CatalogParam[];
  returns: string | null
}

@capabilities(fileRead)
export idempotent def catalog(tools: any[], dir: string = ""): Result<CatalogEntry[]>
```

Each field of the two types gets a doc comment that says what it holds. Reuse the wording from "Calls I made", call 1.

- [ ] **Step 1: Write the failing Agency test**

`tests/agency/workflow/catalog.agency`:

```
// The catalog of tools a workflow may call: what describe and each
// tool's parameter schema say, in the tool list's order. No node here
// calls a model.
import { catalog, CatalogEntry, CatalogParam } from "std::workflow"
import { add, round } from "std::math"
import { searchNotes } from "./fixtures/tools/notes.agency"
import { Json } from "std::validation"
import { getMutable, setMutable } from "../../helpers/mutableVar.js"

const DIR = __dirname + "/fixtures/tools"

/** One parameter as a row: name, type, default, description. */
def paramRow(param: CatalogParam): Json {
  return [param.name, param.type, param.default, param.description]
}

/** Lists `tools`, recording every effect raised in "effects". A true
  `rejectRead` rejects `std::read`. */
def runCatalog(tools: any[], rejectRead: boolean = false): Result<CatalogEntry[]> {
  setMutable("effects", [])
  handle {
    return catalog(tools, DIR)
  } with (intr) {
    getMutable("effects", []).push(intr.effect)
    if (rejectRead && intr.effect == "std::read") {
      return reject("not this file")
    }
    return approve()
  }
}

node stdToolEntry(): Json {
  const listed = runCatalog([round])
  if (listed is failure(err)) {
    return "failed: ${err}"
  }
  const entry = listed.value[0]
  return [
    entry.module,
    entry.name,
    entry.description.startsWith("Round a number"),
    entry.description.includes("@param"),
    map(entry.params, paramRow),
    entry.params[1].schema.description,
    entry.returns,
    getMutable("effects", [])
  ]
}

node localToolEntry(): Json {
  const listed = runCatalog([searchNotes])
  if (listed is failure(err)) {
    return "failed: ${err}"
  }
  const entry = listed.value[0]
  return [
    entry.module,
    entry.description,
    map(entry.params, paramRow),
    entry.params[0].schema,
    entry.returns,
    getMutable("effects", [])
  ]
}

node entriesFollowTheToolList(): Json {
  const listed = runCatalog([searchNotes, add, round])
  return map(listed catch [], \entry -> entry.name)
}

node refusedLikeCheckWorkflow(): Json {
  const listed = runCatalog([round.partial(precision: 2), add.rename("plus")])
  if (listed is success) {
    return "listed"
  }
  const messages = map(listed.data.problems, \problem -> problem.message)
  return [messages, getMutable("effects", [])]
}

node repeatedToolRefused(): Json {
  const listed = runCatalog([add, add])
  if (listed is success) {
    return "listed"
  }
  return map(listed.data.problems, \problem -> problem.message)
}

node rejectedReadKeepsTheRejection(): Json {
  const listed = runCatalog([searchNotes], true)
  return [isFailure(listed), listed.rejected]
}

node emptyToolList(): Json {
  return runCatalog([]) catch "failed"
}
```

This file parses with `agency ast` as written. `catalog.test.json` has one case per node, each `"type": "exact"`:

| node | expectedOutput |
|---|---|
| `stdToolEntry` | `["std::math","round",true,false,[["num","number",null,"The number to round"],["precision","number","0","The number of decimal places. Defaults to 0."]],"Default: 0","number",[]]` |
| `localToolEntry` | `["./notes.agency","Find notes whose title matches the query.",[["query","string",null,"Text to match against note titles"]],{"type":"string"},"Result<Note[]>",["std::read"]]` |
| `entriesFollowTheToolList` | `["searchNotes","add","round"]` |
| `refusedLikeCheckWorkflow` | `[["tool \"round\" is a partial; pass the original def","tool \"plus\" is renamed from \"add\"; pass the original def"],[]]` |
| `repeatedToolRefused` | `["tools \"add\" from \"std::math\" and \"std::math\" have the same name; a workflow imports each tool by its name"]` |
| `rejectedReadKeepsTheRejection` | `[true,true]` |
| `emptyToolList` | `[]` |

Run `make`, then the test. It fails to compile because `catalog` is not exported.

- [ ] **Step 2: Implement `catalog`**

The body has three steps:

1. `_toolRefs(tools, dir)`. On a failure, return `failure(refs.error, refs.data)`, as `_compileWithRanges` does.
2. `_signatures(refs.value, dir)`. On a failure, return it unchanged. Put a one-line comment on this return saying why: the failure keeps its `rejected` flag.
3. Return `success(_catalogEntries(tools, refs.value, signatures.value))`.

The docstring is a tool description, so write it for a model:

```
"""
List the tools a workflow may call, in the order given: each tool's module and name as a step names them, its description, its parameters with their types, defaults, descriptions, and JSON Schemas, and its return type. Refuses the same tool lists `checkWorkflow` refuses. Reading a local tool's module raises `std::read`.

@param tools - The functions the workflow may call
@param dir - The directory a workflow's local modules are named relative to
"""
```

Add one sentence to the module doc comment at the top of the file: "`catalog` lists the tools a workflow may call, with their parameters and return types, for a GUI or a person writing a workflow."

- [ ] **Step 3: Build, run, check, commit**

Run `make`, the Agency test, and `pnpm test:run lib/stdlibCapabilities.test.ts`. The capability test passes because `catalog` carries `fileRead`, the tag `checkWorkflow` carries. Run the other workflow Agency tests too, `check.test.json` and `compile.test.json`, since `_pickSignatures` changed. Then typecheck and `pnpm run lint:structure`, and commit: `std::workflow: catalog`.

---

### Task 5: Docs

**Files:**
- Modify: `docs/dev/stdlib/workflow.md` (a new section "The catalog" before "Not built yet", and the "Not built yet" list)
- Modify: `docs/superpowers/specs/2026-10-26-workflows-design.md` ("The catalog", "Public API", "Left to the builder")
- Modify: the `workflow.md` line in `CLAUDE.md` and in `.claude/skills/agency-stdlib-docs/SKILL.md`. The skill file is tracked under an ignored folder, so stage it with `git add -f`.

- [ ] **Step 1: Write the dev doc section**

State the mechanism and the rules, and leave out the history:

- the two sources and which fields come from each;
- why `type` is Agency text and `schema` is JSON Schema;
- why a parameter the schema leaves out is left out of the catalog;
- that `catalog` starts with the same two steps as `checkWorkflow`, so it refuses the same lists and raises the same prompts;
- that a failed read is passed through unchanged;
- that entries keep the tool list's order.

Show the `round` entry from this plan's background as the example. Remove `catalog` from "Not built yet".

- [ ] **Step 2: Update the spec**

In "Public API", replace `returns: string` with `returns: string | null` and add the `CatalogParam` type. In "The catalog", add one sentence naming the five parameter fields. Remove the `CatalogParam` line from "Left to the builder".

- [ ] **Step 3: Update the index line**

Add "the catalog built from `describe` and each tool's parameter schema" to the end of the `workflow.md` line in both files. Keep the addition that short. The skill file's lines are listed in full where an agent reads them, so long additions cost every reader.

- [ ] **Step 4: Commit**

Commit the four files with the message `docs: the workflow catalog`.

---

### Task 6: PR

- [ ] **Step 1: Check the diff against `docs/dev/contributing/anti-patterns.md`.** Watch for a second reader of `@param` lines, a second printer of a parameter's type or default, and a loop that `map` and `filter` could replace.
- [ ] **Step 2: Reread every comment and doc line you added.** Ask whether a future reader needs it or whether it is an implementation note. Cut the second kind.
- [ ] **Step 3: Push and open the PR**, with its body written to a file. Title: `std::workflow: catalog (ADI-252)`. The body lists what `catalog` returns, the change to `describe`, the seven calls above so the owner can object to each, and the tests.
- [ ] **Step 4: Link the PR on ADI-252.** The owner merges.

## Self-review notes

- Ticket tests: "a `std::` tool and a local `.agency` tool both appear with the right parameters and return type" is `stdToolEntry` and `localToolEntry`. "Refused the same way `checkWorkflow` refuses it: a partial, a renamed function, or a repeated name" is `refusedLikeCheckWorkflow` and `repeatedToolRefused`.
- Spec coverage: "The catalog" says the entry is built "from `describe` and the tool's parameter schema", which are Tasks 2 and 3. "Public API" gives the signature that Task 4 implements.
- Type consistency: `ExportParam` is defined once in `lib/stdlib/agency.ts` and used by `Signature` and `CatalogParam`. The Agency types in `stdlib/agency.agency` and `stdlib/workflow.agency` repeat the same fields, because Agency types are declared in Agency source.
- `catalogEntries` pairs a ref with its tool by name, which is safe because `_toolRefs` refuses a repeated name. It takes the order from the refs, which `_toolRefs` returns in the tool list's order. `entriesFollowTheToolList` checks that order.
