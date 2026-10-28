# Workflows, Part 1: JSON to Agency Source — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `compileWorkflow` turns a workflow JSON into an Agency program, and `checkWorkflow` reports every problem in it by step and field. Nothing runs a workflow yet.

**Architecture:** Four stages over data, in the compiler's shape. Parse (JSON to a typed `Workflow`), resolve (a `ResolvedWorkflow` with every fact the lowering needs), lower (one Template Agency fragment per generated statement, each knowing which step owns it), and render (each fragment printed, the prints placed in a fixed scaffold, and the line map derived from the same prints). All four are pure TypeScript functions in `lib/stdlib/workflow/`, one file each. Lower and render use the TypeScript twins of the template API in `lib/stdlib/template.ts` (`_parseStatements`, `_parseExpr`, `_fill`, `_combine`, `_toSource`) and `_describe` from `lib/stdlib/agency.ts`. The Agency side, `stdlib/workflow.agency`, does the I/O (reading tool signatures, which raises `std::read`) and calls `compile` and `typecheck`.

Untrusted text enters the program by exactly three doors. A value (an argument, a prompt, a context label) is filled into an expression hole, which lifts it to a literal and never parses it. A name (a step id, tool name, argument name, input name) passes the parser's own identifier check in stage 1 before it is ever written into a fragment. Type text is canonicalized through `describe`. Nothing else composes text from workflow content.

**Tech Stack:** Agency stdlib conventions, Template Agency (its TypeScript twins), `std::agency`'s `describe`, `compile`, and `typecheck`, vitest for the TypeScript stages, Agency execution tests for the Agency side.

**Spec:** `docs/superpowers/specs/2026-10-26-workflows-design.md`. Read "How the generator is built" and decisions 13 to 15 before starting.

## Background for someone new to this codebase

- `docs/site/guide/template-agency.md`. A template is Agency code with holes. `fill(code, { hole: value })` puts a value into a hole; a value filled into an expression hole is lifted to a literal node and never parsed (`lib/runtime/template/lift.ts`). A `Code` value filled into a hole is grafted as a tree, so fragments nest without printing in between. `parseStatements(text)` parses text into a `Code` fragment and keeps any `#hole` in it open, so `parseStatements("const x = #value")` followed by `fill(frag, { value })` binds an untrusted value to a trusted name. Checked on 2026-10-27: an identifier hole is not accepted in a `const` name position, so that is the shape to use. `combine([a, b])` joins fragments. `toSource(code)` prints a fragment. The TypeScript twins are `_parseExpr`, `_parseStatements`, `_fill`, `_combine`, and `_toSource` in `lib/stdlib/template.ts`; none of them touches the file system.
- Hygiene, `lib/runtime/template/hygiene.ts`. When a filler mentions a name the template binds in scope at the hole, `fill` renames the template's binder to `__hyg<n>_<name>` so the filler cannot capture it. Function and node parameters count as binders. Verified on 2026-10-27: filling the `#steps` hole of `export node main(inputs: Inputs) { #steps }` with statements that mention `inputs` prints `node main(__hyg1_inputs: Inputs)`, and the body's `inputs` is then undefined. The same rule renames `const note = #value` when the filler is `note.value`. Two consequences shape this plan: the scaffold that declares `inputs` is fixed text, not a template with a hole (Task 6); and no fragment is ever filled with a value that mentions the name that fragment binds (Task 4's naming rules make that impossible).
- Printing, `lib/backends/agencyGenerator.ts:276-310`. Between statements in a body the printer puts a single newline; the blank line it inserts is only between nodes, defs, and type aliases. It prints an object literal argument across several lines and a string with a `\n` in it as one escaped line. So a fragment's line count comes from printing that fragment, and indenting the print changes no count.
- `stdlib/agency.agency` lines 883 to 920, and `lib/stdlib/agency.ts` around line 320. `describe(source)` returns each export of a module with its printed `signature`. A re-export line such as `export { bash } from "std::shell"` resolves to the full entry. A relative re-export cannot resolve from a string, so a user file is read and described directly.
- `docs/site/guide/error-handling.md`. `x is failure` narrows a `Result`; `.value` is only allowed after that (AG2009 otherwise). `x is failure` is also accepted on a non-`Result` value with no diagnostic, so the generator must know a tool's return type to decide whether to emit `.value`.
- `lib/parsers/parsers.ts:1175`, `identifierParser`. A tarsec parser; `identifierParser(text)` returns `{ success: true, result, rest }` or a failure. An identifier is accepted when it succeeds with an empty `rest`. It also refuses reserved `__` names.
- `lib/runtime/toolInvocation.ts:263`, `assertUniqueToolNames(tools)`. Throws with the message that points at `.rename()`.
- `lib/runtime/agencyFunction.ts` lines 120 to 175. A function value has `name`, `module`, `registeredName` (the name before any `.rename()`), `created`, `params`, and `getUnboundParams()`.
- `lib/typeChecker/diagnostics.ts:345`. The diagnostic for a wrong named argument (AG6012) renders `fn`, `name`, and `allowed` into its message. `TypeCheckDiagnostic` (`stdlib/agency.agency:136`) exposes those values as `params: Record<string, string | number>`, so the argument name is `params.name`, never parsed out of the message.
- `lib/backends/agencyGenerator.ts:1264`, `signatureOf`. For a type alias, `describe` prints the whole declaration as the signature, `type Inputs = { noteTitle: string }`, not just the right-hand side. The render step writes that signature as the line.
- `stdlib/toolbox.agency`, `assembleTool` at line 998, for how a template is filled, compiled with `compile(source, dir, strict: true)`, and typechecked with `typecheck(source, dir:, strict: true)`.

## Global Constraints

- The format version is `1`. A reader refuses any other value.
- `name`, every step id, every tool name, and every input name are identifiers as `identifierParser` decides.
- A reference is exactly an object with one key `$ref`. Its path matches `^(inputs|steps)\.[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*|\[[0-9]+\])*$` and the segment after `inputs.` or `steps.` is an identifier.
- A reference may only name a declared input or a step earlier in the list.
- Every name the generated body declares carries the prefix `step_` (Task 4), so a step id can never shadow `inputs`, `failure`, `llm`, a tool, or a keyword, and no step id equals a local another step binds. Every declared name is therefore distinct, which is what keeps hygiene from renaming anything.
- Every problem is `{ step, field, message }`; `step` and `field` are null only for a problem that belongs to the whole workflow.
- The same workflow and tool list produce the same source text.
- Workflow content reaches a fragment only as a filled value or as a checked name. Every generated statement comes from the `SHAPES` table through `statement`, which checks each name it substitutes (Task 5). The only text composed outside it is a reference path that matched `REF_PATH`, an import line from Task 3's checked module path, and the scaffold constants.
- No new code under `lib/runtime/`. No `fs` import in `lib/stdlib/workflow/`.
- `pnpm run typecheck`, `pnpm run lint:structure`, and `npx prettier --check` on the changed TypeScript pass before every commit. `make` is run only after a change to a `stdlib/*.agency` file.
- No Agency execution test in this plan makes a model call.

## Review Focus

1. A step id, tool name, or input name of `x } import evil` is refused by parse, never composed into source. Pinned in Task 2.
2. A string argument containing `${`, `"""`, or `}` reaches the program as that exact string, because it is lifted into a fragment and never parsed. Pinned in Task 5 (the printed fragment) and Task 7 (the compiled program).
3. `inputs` text that carries a second declaration (`{ a: string }\nexport node evil() {}`) is refused when canonicalized, with a message naming `inputs`. Pinned in Task 6.
4. A workflow that names a tool the host did not pass is refused in resolve, even when a `std::` function of that name exists. Pinned in Task 4.
5. A tool returning a plain value is referenced without `.value`; one returning a `Result` with it; and a reference into a step that returns `any` is a run-time matter the check reports as a warning, not an error. Pinned in Tasks 4 and 8.
6. The generated program declares `node main(inputs: Inputs)` with that exact parameter name, every generated local starts with `step_`, and a step id that would produce the same local as another step is refused before anything is generated. Pinned in Tasks 4 and 7.
7. A workflow with no `limits`, and one whose last step returns a plain value, both typecheck, because the result line is always `return success(...)`. Pinned in Task 7.

---

## File structure

- Modify `lib/stdlib/agency.ts` and `stdlib/agency.agency`: add `returnType: string | null` to `ExportInfo`.
- Create `lib/stdlib/workflow/types.ts`: the data shapes every stage shares.
- Create `lib/stdlib/workflow/parse.ts` and `parse.test.ts`.
- Create `lib/stdlib/workflow/tools.ts` and `tools.test.ts`: function values to `ToolRef`s.
- Create `lib/stdlib/workflow/resolve.ts` and `resolve.test.ts`.
- Create `lib/stdlib/workflow/shapes.ts` and `shapes.test.ts`: the table of generated statement shapes, and the one function that turns a shape into a fragment.
- Create `lib/stdlib/workflow/lower.ts` and `lower.test.ts`: a resolved workflow to fragments.
- Create `lib/stdlib/workflow/render.ts` and `render.test.ts`: fragments to source text and line ranges, with the scaffold constant.
- Create `lib/stdlib/workflow/problems.ts` and `problems.test.ts`: diagnostics to problems through the line ranges.
- Create `lib/stdlib/workflow/index.ts`: `compileWorkflowSource`, the pure pipeline from a workflow, tool refs, and signatures to source, ranges, and warnings; and re-exports of the hidden bindings `stdlib/workflow.agency` imports, under the `_` names the stdlib convention uses.
- Create `stdlib/workflow.agency`: types, `_signatures`, `compileWorkflow`, `checkWorkflow`.
- Create `tests/agency/workflow/fixtures/tools/notes.agency` and `lists.agency`, and the execution tests `compile.agency` and `check.agency` with their `.test.json`.
- Create `docs/dev/stdlib/workflow.md`; add its line to `CLAUDE.md` and `.claude/skills/agency-stdlib-docs/SKILL.md`; add the sidebar entry in `docs/site/.vitepress/config.mts` between `weather` and `wikipedia`.

---

### Task 1: `describe` prints a return type

**Files:**
- Modify: `stdlib/agency.agency:883-893` (`ExportInfo`)
- Modify: `lib/stdlib/agency.ts:318-332` and the two other places `signature:` is set for defs and nodes
- Test: `lib/stdlib/agency.describe.test.ts` (create if there is no describe test; else add to the existing one)

**Interfaces:**
- Produces: `ExportInfo.returnType: string | null`. For a def or node, the declared return type printed by the same printer `signatureOf` uses (`variableTypeToString` from `lib/backends/typescriptGenerator/typeToString.js`); null when none is declared. For a type, const, or re-export entry, null.

- [ ] **Step 1: Write the failing test**

```ts
it("prints the declared return type on its own", () => {
  const info = _describe('export def f(q: string): Result<string[]> { return success([q]) }\nexport def g(q: string) { return q }');
  expect(info.exports.map((e) => [e.name, e.returnType])).toEqual([["f", "Result<string[]>"], ["g", null]]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/stdlib/agency.describe.test.ts > /tmp/wf-t1.txt 2>&1; tail -15 /tmp/wf-t1.txt`
Expected: FAIL, `returnType` is undefined.

- [ ] **Step 3: Add the field in both files**

In `stdlib/agency.agency`, add `returnType: string | null;` to `ExportInfo` with a doc comment: "The declared return type, printed on its own. Null when none is declared." In `lib/stdlib/agency.ts`, set it beside `signature` for defs and nodes; `null` for the other kinds.

- [ ] **Step 4: Run it to verify it passes, then run the existing describe and toolbox unit tests**

Run: `npx vitest run lib/stdlib/agency > /tmp/wf-t1.txt 2>&1; tail -15 /tmp/wf-t1.txt`
Expected: PASS.

- [ ] **Step 5: Build the stdlib (the `.agency` type changed), format, and commit**

Run: `make > /tmp/wf-make.txt 2>&1; tail -3 /tmp/wf-make.txt; npx prettier --write lib/stdlib/agency.ts lib/stdlib/agency.describe.test.ts; pnpm run typecheck > /tmp/wf-tc.txt 2>&1; tail -3 /tmp/wf-tc.txt`

```bash
git add stdlib/agency.agency lib/stdlib/agency.ts lib/stdlib/agency.describe.test.ts docs/site/stdlib/agency.md
git commit -F - <<'EOF'
describe: print each export's return type as its own field

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 2: Parse

**Files:**
- Create: `lib/stdlib/workflow/types.ts`
- Create: `lib/stdlib/workflow/parse.ts`
- Test: `lib/stdlib/workflow/parse.test.ts`

**Interfaces:**
- Produces in `types.ts`:

```ts
export type Problem = { step: string | null; field: string | null; message: string };
export type Ref = { $ref: string };
export type ToolStep = { id: string; kind: "tool"; module: string; tool: string; args: Record<string, unknown> };
export type LlmStep = { id: string; kind: "llm"; prompt: string; context: unknown[]; output: string; model?: string; provider?: string };
export type Step = ToolStep | LlmStep;
export type Limits = { maxCost?: number; maxTime?: number };
export type Workflow = { format: 1; name: string; description: string; inputs: string; steps: Step[]; result?: unknown; limits?: Limits };
export function isRef(value: unknown): value is Ref;
export function isIdentifier(text: string): boolean;   // identifierParser succeeds with empty rest
export function refsIn(value: unknown): Ref[];        // every Ref nested anywhere in a value, in document order
export const REF_PATH: RegExp;
```

- Produces in `parse.ts`: `export type ParseResult = { workflow: Workflow; problems: [] } | { workflow: null; problems: Problem[] }` and `export function parseWorkflow(value: unknown): ParseResult`. Internally `const RULES: ((value: Record<string, unknown>) => Problem[])[]`, one per rule below, and `parseWorkflow` is their concatenation after one check that `value` is an object. Rules: format is `1`; `name` is an identifier; `description` is a string; `inputs` is a string whose property names (matched by `([A-Za-z_][A-Za-z0-9_]*)\s*:`) are identifiers; `steps` is an array; every step id is an identifier and unique (the problem lands on the second occurrence); every kind is `tool` or `llm`; a tool step has string `module` and identifier `tool` and object `args`; an llm step has a non-empty string `prompt`, an array `context`, a string `output`, and optional string `model` and `provider`; every reference in `args`, `context`, and `result` has a path matching `REF_PATH`; `limits`, when present, has only `maxCost` and `maxTime`, each a finite number (they are written into the guard line as text, so `Infinity` and `NaN` are refused here).

- [ ] **Step 1: Write the failing tests**

The fixture `mealPlan` is the spec's example with `module` values `"./notes.agency"` and `"./lists.agency"`. Helpers `withStep(wf, index, patch)` and `withArg(wf, stepId, name, value)` deep-copy.

```ts
it("accepts the meal plan", () => { expect(parseWorkflow(mealPlan).problems).toEqual([]); });
it("refuses a step id that is not an identifier", () => {
  expect(parseWorkflow(withStep(mealPlan, 0, { id: "x } import evil" })).problems).toEqual([
    { step: "x } import evil", field: "id", message: 'step id "x } import evil" is not an identifier' },
  ]);
});
it("refuses a reserved step id", () => { /* id "__note", message contains "reserved" */ });
it("refuses a tool name that is not an identifier", () => { /* field "tool" */ });
it("refuses a format other than 1", () => { /* step null, field "format" */ });
it("refuses a duplicate step id on the second occurrence", () => {});
it("refuses an unknown kind", () => { /* field "kind" */ });
it("refuses a malformed reference path", () => { /* "$ref": "steps.note[0.id", field "args.id" */ });
it("refuses an llm step with an empty prompt", () => { /* field "prompt" */ });
it("refuses an input name that is not an identifier", () => { /* inputs "{ 1x: string }", field "inputs" */ });
it("reports every problem, not the first", () => { /* two bad ids -> two problems */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run lib/stdlib/workflow/parse.test.ts > /tmp/wf-t2.txt 2>&1; tail -15 /tmp/wf-t2.txt`

- [ ] **Step 3: Implement `types.ts` and `parse.ts`**

`isIdentifier` calls `identifierParser` from `lib/parsers/parsers.ts`. `refsIn` is a recursive walk that returns `Ref` objects and does not descend into one. The input-name regex also matches nested field names (`{ a: { b: string } }` yields `a` and `b`); that is accepted, because the rule only needs every name it finds to be an identifier, and a reference to a nested name as if it were an input is a type error the typechecker reports against the step's line.

- [ ] **Step 4: Run them to verify they pass; format; typecheck; commit**

```bash
git add lib/stdlib/workflow/types.ts lib/stdlib/workflow/parse.ts lib/stdlib/workflow/parse.test.ts
git commit -F - <<'EOF'
workflow: parse a workflow JSON into a typed value or problems

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 3: Tool references from function values

**Files:**
- Create: `lib/stdlib/workflow/tools.ts`
- Test: `lib/stdlib/workflow/tools.test.ts`

**Interfaces:**
- Produces: `export type ToolRef = { module: string; name: string }` (in `types.ts`) and `export function toolRefs(tools: unknown[], dir: string): ToolRef[]`. `module` is the text an import line would use, which is also what a workflow's `module` field must say: a function value's `module` is the compiler's module id, a file path (`lib/backends/typescriptBuilder.ts:387`, written at `:2680`), and `moduleIdToOrigin` in `lib/runtime/origin.ts` turns it into `std::<name>`, `pkg::<name>`, or `./<path>`. A `std::` or `pkg::` result is used as is, after one check: `moduleIdToOrigin` matches any path containing `/stdlib/`, so confirm the id is under Agency's own stdlib directory before accepting `std::`; a user file at `src/stdlib/notes.agency` stays local. A `./` result is a local file, and `toolRefs` rewrites it relative to `dir` (`path.relative(dir, resolved)`, with `./` in front), refusing one that lands outside `dir` (`'tool "a" is defined in "<path>", outside the workflow directory'`). Before writing this, confirm what a user file's module id looks like at run time (absolute, or relative to the working directory at compile time): compile a two-file fixture with `pnpm run compile` and read the `module:` string in the output. The rewrite depends on the answer and the plan does not assume one. Throws an `Error` for: a value that is not an `AgencyFunction` (`"tool 3 is not an Agency function"`); a renamed function (`'tool "b" is renamed from "a"; pass the original def'`); a partial (`'tool "a" is a partial; pass the original def'`); a created tool (`'tool "a" was built by createTool and cannot be imported'`); a module path that does not match `MODULE_PATH = /^[A-Za-z0-9_@:./-]+$/` (`'tool "a" comes from a module path that cannot be written in an import'`). The module path is written into an import line as text, so the pattern is what makes that safe: no quote, backslash, space, or newline. Duplicate names are left to `assertUniqueToolNames`, called last.

- [ ] **Step 1: Write the failing tests**

Build function values the way `lib/runtime/createdTool.test.ts` does. One `it` per refusal and one for the happy path: a function whose `module` is `<dir>/notes.agency` gives `{ module: "./notes.agency", name: "searchNotes" }`, and one whose `module` ends in `stdlib/shell.agency` gives `{ module: "std::shell", name: "bash" }`; a function from a file outside `dir` is refused; the duplicate case asserts the message contains `.rename(`; the module path case uses `'a" } import evil from "x'`.

- [ ] **Step 2: Run to verify they fail; implement; run to verify they pass; format; typecheck; commit**

```bash
git add lib/stdlib/workflow/types.ts lib/stdlib/workflow/tools.ts lib/stdlib/workflow/tools.test.ts
git commit -F - <<'EOF'
workflow: read module and name from the function values a host passes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 4: Resolve

**Files:**
- Create: `lib/stdlib/workflow/resolve.ts`
- Test: `lib/stdlib/workflow/resolve.test.ts`

**Interfaces:**
- Consumes: `Workflow`, `ToolRef`, and `Signature = { signature: string; returnType: string | null; docstring: string | null }` keyed by `"<module>.<name>"`.
- Produces (in `types.ts`):

```ts
export type ResolvedRef = { kind: "input"; name: string; path: string } | { kind: "step"; step: string; path: string };
// path is the text after the root, e.g. "[0].id" or "".
export type Binding = { local: string; field: string; value: unknown | ResolvedRef };  // field: "args.query", "context[0]", "prompt"
export type ResolvedToolStep = { id: string; kind: "tool"; module: string; tool: string; returnsResult: boolean; bindings: Binding[]; argOrder: string[] };
export type ResolvedLlmStep = { id: string; kind: "llm"; outputType: string; bindings: Binding[]; model: string | null; provider: string | null };
export type ResolvedStep = ResolvedToolStep | ResolvedLlmStep;
export type ResolvedWorkflow = { name: string; inputsType: string; imports: { module: string; names: string[] }[]; steps: ResolvedStep[]; result: unknown | ResolvedRef | null; limits: Limits | null; warnings: Problem[] };
```

  and in `resolve.ts`: `export type ResolveResult = { resolved: ResolvedWorkflow; problems: [] } | { resolved: null; problems: Problem[] }` and `export function resolveWorkflow(workflow: Workflow, refs: ToolRef[], signatures: Record<string, Signature>): ResolveResult`. Rules, as a list like parse's: every tool step's `(module, tool)` is in `refs` (`'tool "bash" from "std::shell" is not among the tools passed to this workflow'`); a signature exists for it (`'no signature for "./notes.agency"."searchNotes"'`); every reference names a declared input or an earlier step (`'reference "steps.list[0].id" names step "list", which comes after this step'`, `'reference "inputs.nope" names no declared input'`); no two generated names are equal (`'step id "note_query" produces the same local as argument "query" of step "note"'`, reported on the later step, field `id`). Derivations: `returnsResult` is `returnType` starting with `Result`; a tool step with `returnType` null or `any` adds a warning `'step "note": "searchNotes" declares no return type, so references into its value are checked at run time'`; `bindings` are one per argument sorted by name, one per context value in order, and one for the prompt; `argOrder` is the sorted names; `imports` are grouped by module, modules sorted, names sorted; `inputsType` is the `inputs` text as given.

  **Generated names.** Every name the body declares comes from one function, `names(id)` in `resolve.ts`: the step's value is `step_<id>`, an argument local is `step_<id>_<arg>`, a context local is `step_<id>_context<n+1>`, the llm output type is `Step_<id>_output`. The prefix is what makes a step id harmless: `failure`, `llm`, `searchNotes`, `inputs`, `thread`, or `Inputs` as a step id produces `step_failure`, which shadows nothing. Without it, a step named `failure` would turn every later `return failure(...)` into a call of the step's value. Messages still say `step "note"`, because the owner carries the id. The one collision the prefix does not remove is two steps producing the same local (`note` with argument `query`, and `note_query`), which the rule above refuses.

  The rule also serves hygiene (see Background). Every `const` the body declares is a generated name, every reference mentions `inputs` or a generated name, and a fragment is only ever filled with a reference or a literal. With all generated names distinct and none equal to `inputs`, no fragment binds a name its filler mentions, so `fill` never renames anything.

- [ ] **Step 1: Write the failing tests**

```ts
it("resolves the meal plan", () => {
  const r = resolveWorkflow(mealPlan, mealRefs, mealSignatures);
  expect(r.problems).toEqual([]);
  expect(r.resolved!.imports).toEqual([{ module: "./lists.agency", names: ["addListItems", "findLists"] }, { module: "./notes.agency", names: ["readNote", "searchNotes"] }]);
  expect(r.resolved!.steps[1]).toEqual({ id: "text", kind: "tool", module: "./notes.agency", tool: "readNote", returnsResult: true,
    bindings: [{ local: "step_text_id", field: "args.id", value: { kind: "step", step: "note", path: "[0].id" } }], argOrder: ["id"] });
  expect(r.resolved!.steps[3]).toMatchObject({ id: "meals", kind: "llm", outputType: "string[]",
    bindings: [{ local: "step_meals_context1", field: "context[0]", value: { kind: "step", step: "text", path: ".body" } }, { local: "step_meals_prompt", field: "prompt" }] });
});
it("refuses a tool the host did not pass, even a std one", () => { /* module "std::shell", tool "bash", refs unchanged */ });
it("refuses a forward reference", () => {});
it("refuses an unknown input", () => {});
it("marks a plain return as not a Result", () => { /* signature returnType "string"; returnsResult false */ });
it("warns on a tool with no return type", () => { /* returnType null -> warnings has one entry, problems empty */ });
it("prefixes every generated name", () => { /* a step named "failure" resolves to value name "step_failure" */ });
it("refuses a step id that produces another step's local", () => { /* steps "note" (arg query) and "note_query"; problem on step "note_query", field "id" */ });
```

- [ ] **Step 2: Run to verify they fail; implement; run to verify they pass; format; typecheck; commit**

```bash
git add lib/stdlib/workflow/types.ts lib/stdlib/workflow/resolve.ts lib/stdlib/workflow/resolve.test.ts
git commit -F - <<'EOF'
workflow: resolve a workflow against the tools and their signatures

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 5: Lower

**Files:**
- Create: `lib/stdlib/workflow/lower.ts`
- Test: `lib/stdlib/workflow/lower.test.ts`

**Interfaces:**
- Consumes: `ResolvedWorkflow`.
- Produces (in `types.ts`):

```ts
import type { Code } from "../template.js";
export type Owner = { step: string; field: string | null };
export type Fragment = { code: Code; owner: Owner | null };
export type TypeDecl = { name: string; text: string; owner: Owner | null };   // canonicalized in render
export type Lowered = { imports: string[]; types: TypeDecl[]; body: Fragment[]; result: Code; guard: Limits | null };
```

  and `export function lowerWorkflow(resolved: ResolvedWorkflow): Lowered`. A `Code` value is an AST fragment, so tests assert on `_toSource(fragment.code)`; the expected strings below are what the printer prints.

  The shapes of the generated statements live in one table, and one function turns a shape into a fragment. The table is the "what"; the function is the only "how":

```ts
// lib/stdlib/workflow/shapes.ts
export const SHAPES = {
  binding: "const {{local}} = #value",
  call: "const {{value}} = {{tool}}({{args}})",
  check: 'if ({{value}} is failure) {\n  return failure("step {{id}} ({{tool}}): ${{{value}}.error}", { step: #id, cause: {{value}} })\n}',
  llm: "const {{value}}: {{outputType}} = thread {\n  return llm(#prompt{{options}})\n}",
  concat: "#left + #right",
  stringify: "JSON.stringify(#v)",
} as const;

export function statement(shape: keyof typeof SHAPES, names: Record<string, string>, values: Record<string, unknown>): Code;
export function expression(shape: keyof typeof SHAPES, names: Record<string, string>, values: Record<string, unknown>): Code;
```

  A `{{name}}` token is a name: `statement` replaces it with `names[name]` after checking that the replacement is a generated name, a checked identifier, or (for `args` and `options`) a comma-joined list of `identifier: identifier` pairs, and throws otherwise. That check is the one door for every name that enters generated text, and it cannot be skipped because there is no other way to build a fragment. A `#name` hole is a value: the text is parsed with `_parseStatements` (or `_parseExpr`), then `_fill`ed with `values`, which lifts a plain value and grafts a `Code` value. `shapes.ts` has no other exports and imports only `lib/stdlib/template.ts` and `isIdentifier`.

  `lower.ts` then has one small function per generated thing, each a call into the table:

  - `reference(ref, returnsResult): Code` is `_parseExpr(text)` where `text` is `inputs.<name><path>` or `step_<id>[.value]<path>`. Every character of it is a checked identifier, `.value`, or a path that matched `REF_PATH`. This is the one expression not built from a shape, because a path is not a name; it is pinned by `REF_PATH` instead.
  - `binding(local, value)` is `statement("binding", { local }, { value })`. For a literal argument `value` is the JSON value, which `fill` lifts to a literal. For a reference argument `value` is `reference(...)`, grafted as a tree.
  - `call(step)` and `check(step)` are `statement("call", ...)` and `statement("check", ...)`, with `args` the `argOrder` names mapped to `<arg>: step_<id>_<arg>` and joined.

  `imports` are the lines `import { a, b } from "<module>"` (names checked in Task 2, module paths in Task 3). `types` holds `Inputs` and one `Step_<id>_output` per llm step, text as given. `body` holds, per tool step in order: a binding per argument (literal or reference), the call, and the check. The check is emitted for every tool step, not only a `Result`-typed one, because Agency wraps every function in a try-catch that turns a thrown error into a failure (`docs/site/guide/error-handling.md`), and `x is failure` typechecks on any value. `returnsResult` decides only whether a reference into the step adds `.value`. For an llm step: a binding per context value, then `statement("llm", { value, outputType, options }, { prompt, model?, provider? })`, where `options` is `", model: #model"` and `", provider: #provider"` for the ones bound (a `#` hole inside a name token is allowed only for `options`, and `statement` checks that the token's text is exactly those two pieces). `prompt` is a `Code` expression: `parts.reduce((left, right) => expression("concat", {}, { left, right }))` over the prompt text (a string, lifted), then for each context value the label `"\n\nContext <n> (<ref path>):\n"` (a string, lifted) and `expression("stringify", {}, { v: _parseExpr("step_<id>_context<n>") })`. `model` and `provider` are strings, lifted. Verified on 2026-10-27 that this prints as `return llm(\n    "..." + "\n\nContext 1 (steps.text.body):\n" + JSON.stringify(meals_context1),\n    model: "gpt-5",\n  )`. `result` is `reference(...)` of the `result` field, or `_parseExpr("step_<last id>[.value]")`; render wraps it in `success(...)`. Owners: a binding owns its `field`; the call and the check own `{ step, field: "args" }`; the llm statement owns `{ step, field: "prompt" }`.

  No fragment binds a name its filler mentions (Task 4's rules), so `fill` renames nothing. A test pins that.

- [ ] **Step 1: Write the failing tests**

```ts
const print = (f: Fragment) => [_toSource(f.code), f.owner] as const;
it("lowers the meal plan to fragments", () => {
  const lowered = lowerWorkflow(resolvedMealPlan);
  expect(lowered.imports).toEqual(['import { addListItems, findLists } from "./lists.agency"', 'import { readNote, searchNotes } from "./notes.agency"']);
  expect(lowered.types[0]).toEqual({ name: "Inputs", text: "{ noteTitle: string }", owner: null });
  expect(lowered.body.slice(0, 2).map(print)).toEqual([
    ["const step_note_query = inputs.noteTitle", { step: "note", field: "args.query" }],
    ["const step_note = searchNotes(query: step_note_query)", { step: "note", field: "args" }],
  ]);
  expect(print(lowered.body[2])[0]).toMatch(/^if \(step_note is failure\) \{\n  return failure\("step note \(searchNotes\): \$\{step_note\.error\}", \{/);  // the object prints across lines; pin the exact text on first run
  expect(_toSource(lowered.result)).toBe("step_add.value");
});
it("lifts a literal argument and never parses it", () => {
  // query: '${evil} """ }' prints as:  const step_list_query = "\${evil} \"\"\" }"   (verified 2026-10-27)
});
it("keeps the check but omits .value for a plain return", () => { /* splitLines: "if (step_lines is failure)" present, no "step_lines.value" anywhere */ });
it("lowers an llm step with its context and model", () => { /* the thread statement print above */ });
it("never renames a binder", () => { expect(lowered.body.map(print).join("\n")).not.toContain("__hyg"); });
it("is deterministic", () => { expect(lowerWorkflow(r).body.map(print)).toEqual(lowerWorkflow(r).body.map(print)); });
```

  and in `shapes.test.ts`:

```ts
it("refuses a name token that is not an identifier", () => { expect(() => statement("binding", { local: "x } import evil" }, { value: 1 })).toThrow(); });
it("lifts a value hole and never parses it", () => { /* value '${evil}' prints as a string literal */ });
it("grafts a Code value", () => { /* value _parseExpr("inputs.a") prints as inputs.a */ });
```

- [ ] **Step 2: Run to verify they fail; implement; run to verify they pass; format; typecheck; commit**

```bash
git add lib/stdlib/workflow/types.ts lib/stdlib/workflow/shapes.ts lib/stdlib/workflow/shapes.test.ts lib/stdlib/workflow/lower.ts lib/stdlib/workflow/lower.test.ts
git commit -F - <<'EOF'
workflow: lower a resolved workflow to template fragments that know their owner

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 6: Render, and diagnostics to problems

**Files:**
- Create: `lib/stdlib/workflow/render.ts`
- Create: `lib/stdlib/workflow/problems.ts`
- Test: `lib/stdlib/workflow/render.test.ts`, `lib/stdlib/workflow/problems.test.ts`

**Interfaces:**
- Produces in `types.ts`: `export type Range = { from: number; to: number; owner: Owner }` (1-based, inclusive).
- Produces in `render.ts`: `export type RenderResult = { source: string; ranges: Range[]; problems: [] } | { source: null; ranges: []; problems: Problem[] }` and `export function renderWorkflow(lowered: Lowered): RenderResult`.
- Produces in `problems.ts`: `export function problemsFromDiagnostics(diagnostics: { message: string; loc?: { line: number }; params?: Record<string, string | number> }[], ranges: Range[]): Problem[]`. A diagnostic whose line falls in a range becomes `{ step, field, message }`; when the range's field is `"args"` and `params.name` is a string, the field is `"args.<name>"`; a diagnostic in no range is `{ step: null, field: null, message }`.

  `renderWorkflow` does four things, in order:

  1. **Types.** Each `TypeDecl` is canonicalized: `_describe("export type <name> = <text>")` must return exactly one export, of kind `type`, named `<name>`, and the line written is that export's `signature`, which `describe` prints as the whole declaration, `type Inputs = { noteTitle: string }` (Background). Otherwise the problem is `'<field> must be one object type'` with the decl's owner, or `{ step: null, field: "inputs" }` for `Inputs`. Every type problem is collected; when there are any, nothing is rendered.
  2. **Body.** Each fragment is printed on its own with `_toSource`, and its line count is the count of that print. The result line is `"return success(" + _toSource(lowered.result) + ")"`, always. `main` is typed `Result`, so a plain value (`step_lines`, a `string[]`) or a `.value` would fail AG2001 without the wrap; under a guard, a block that returns a `Result` comes out of the guard unwrapped once (`lib/runtime/result.ts`, `normalizeForeignResult`), so the wrap is right there too.
  3. **Scaffold.** Two string constants in `render.ts`, `SCAFFOLD` and `GUARDED_SCAFFOLD`, so the shape of every generated program is readable in one place. They are fixed text, not a template with a hole, because filling a hole inside `node main(inputs: Inputs)` with statements that mention `inputs` renames the parameter (see Background). `GUARDED_SCAFFOLD`:

```
import { Json } from "std::validation"
{{imports}}

{{types}}

export node main(inputs: Inputs): Result {
  return guard({{guardArgs}}) {
{{body}}
  }
}

export node inputsSchema(): Json {
  return schema(Inputs).toJSONSchema()
}
```

     and `SCAFFOLD` is the same without the two guard lines. `{{imports}}` and `{{types}}` are the joined lines; `{{guardArgs}}` is the present limits as `time: 300000, cost: 1` (one of them when only one is set), each number written with `String(n)`, which parse guaranteed finite; `{{body}}` is the per-fragment prints followed by the result line, every line indented by `INDENT` (two spaces) per enclosing block. The substitution is one `replace` per token; no token's replacement contains another token's text. Indenting a print never lands inside a value, because the printer writes a `\n` in a string as the two characters `\n` (Background).
  4. **Ranges.** The first body line is the line number of `{{body}}` in the scaffold after `{{imports}}` and `{{types}}` are substituted. Ranges are a `reduce` over the fragments carrying `start`: fragment `i` covers `[start_i, start_i + lines_i - 1]`, and a fragment with no owner takes lines and produces no range. Because the body text is the join of the per-fragment prints, these counts are exact by construction. No combined print is made, so there is no second print that could disagree with the first.

- [ ] **Step 1: Write the failing tests**

```ts
it("renders the body and the ranges from the same prints", () => {
  // Two hand-built fragments: one line, then three lines. Header for one import and one type is 8 lines.
  const r = renderWorkflow(lowered);
  expect(r.source.split("\n").slice(8, 12)).toEqual(["  const a = 1", "  if (a is failure) {", "    return a", "  }"]);
  expect(r.ranges).toEqual([{ from: 9, to: 9, owner: oa }, { from: 10, to: 12, owner: ob }]);
});
it("indents the body by four under a guard and shifts the ranges by one", () => { /* source contains "  return guard(time: 300000, cost: 1) {" */ });
it("canonicalizes a type through describe", () => { /* "{ noteTitle: string }" prints as the signature describe gives; copy it on first run */ });
it("refuses type text that carries a second declaration", () => {
  expect(renderWorkflow(withInputs(lowered, "{ a: string }\nexport node evil() { return 1 }")).problems)
    .toEqual([{ step: null, field: "inputs", message: "inputs must be one object type" }]);
});
it("refuses an llm output type the same way, naming the step", () => { /* owner { step: "meals", field: "output" } */ });
it("is deterministic", () => {});
```

  and in `problems.test.ts`:

```ts
it("maps a diagnostic to the owner of its line", () => {});
it("takes the argument name from the payload, not the message", () => {
  const ranges = [{ from: 5, to: 5, owner: { step: "note", field: "args" } }];
  expect(problemsFromDiagnostics([{ message: "'searchNotes' does not accept the named argument 'querry'.", loc: { line: 5 }, params: { fn: "searchNotes", name: "querry", allowed: "query" } }], ranges))
    .toEqual([{ step: "note", field: "args.querry", message: "'searchNotes' does not accept the named argument 'querry'." }]);
});
it("keeps a diagnostic with no owner", () => {});
```

- [ ] **Step 2: Run to verify they fail; implement; run to verify they pass; format; typecheck; commit**

```bash
git add lib/stdlib/workflow/types.ts lib/stdlib/workflow/render.ts lib/stdlib/workflow/render.test.ts lib/stdlib/workflow/problems.ts lib/stdlib/workflow/problems.test.ts
git commit -F - <<'EOF'
workflow: render fragments into the scaffold, with line ranges from the same prints

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 7: `compileWorkflow` in Agency

**Files:**
- Create: `lib/stdlib/workflow/index.ts`
- Create: `stdlib/workflow.agency`
- Create: `tests/agency/workflow/fixtures/tools/notes.agency`, `lists.agency`, `tests/agency/workflow/compile.agency`, `compile.test.json`

**Interfaces:**
- Produces in `index.ts`:

```ts
export type Compiled = { source: string; ranges: Range[]; warnings: Problem[] };
export function compileWorkflowSource(value: unknown, refs: ToolRef[], signatures: Record<string, Signature>): { compiled: Compiled; problems: [] } | { compiled: null; problems: Problem[] };
```

  It runs parse, resolve, lower, and render in order and returns the first stage's problems. It is the whole generator with the I/O taken out, so a vitest test can drive it end to end on data. `index.ts` also exports, for the Agency file: `_toolRefs` (wrapped to return `{ refs } | { error }` instead of throwing), `_compileWorkflowSource`, and `_problemsFromDiagnostics`.

- Produces in Agency:

```text
export type Workflow = { format: number; name: string; description: string; inputs: string; steps: Json[]; result?: Json; limits?: WorkflowLimits }
export type WorkflowLimits = { maxCost?: number; maxTime?: number }
export type WorkflowProblem = { step: string | null; field: string | null; message: string }
type Compiled = { source: string; ranges: Json; warnings: WorkflowProblem[] }

@hidden export def _signatures(refs: ToolRef[], dir: string): Result<Record<string, ExportInfo>>
@hidden export def _compileWithRanges(workflow: Workflow, tools: any[], dir: string): Result<Compiled, { problems: WorkflowProblem[] }>
export def compileWorkflow(workflow: Workflow, tools: any[], dir: string = ""): Result<string, { problems: WorkflowProblem[] }>
```

  `_signatures`: for the `std::` modules in `refs`, one `describe` on the re-export lines (`export { a, b } from "std::x"`, one line per module); for each other module, `read(module, dir)` then `describe`; a missing export is a failure `'"<module>" exports no function named "<name>"'`. `_compileWithRanges` is three calls: `_toolRefs(tools, dir)`, `_signatures`, `_compileWorkflowSource`. The Agency side holds no generation logic; it exists because reading a user's module raises `std::read`.

- [ ] **Step 1: Write the fixtures and the failing Agency test**

`notes.agency` exports `type Note = { id: string; title: string; body: string }`, `searchNotes(query: string): Result<Note[]>`, `readNote(id: string): Result<Note>`, and `splitLines(text: string): string[]` (a plain return), each with a docstring. `lists.agency` exports `type ListSummary = { id: string; title: string }`, `findLists(query: string): Result<ListSummary[]>`, and `addListItems(listId: string, items: string[], section: string): Result<string>`.

`compile.agency` imports the five tools and `compileWorkflow`, holds `mealPlan` as a `const` (modules `"./notes.agency"` and `"./lists.agency"`), and `const DIR = __dirname + "/fixtures/tools"`. Nodes, every call under `with approve` for the `std::read`:

- `mealPlanCompiles(): boolean`: success, and the source contains each of: `import { readNote, searchNotes, splitLines } from "./notes.agency"` (adjust to the tools passed), `type Inputs = { noteTitle: string }`, `type Step_meals_output = string[]`, `export node main(inputs: Inputs): Result {`, `const step_note_query = inputs.noteTitle`, `const step_note = searchNotes(query: step_note_query)`, `if (step_note is failure)`, `const step_text_id = step_note.value[0].id`, `const step_meals: Step_meals_output = thread {`, `const step_add = addListItems(items: step_add_items, listId: step_add_listId, section: step_add_section)`, `return guard(time: 300000, cost: 1)`, `return success(step_add.value)`; and does not contain `__hyg`.
- `generatedProgramTypechecks(): boolean`: `typecheck(source, dir: DIR, strict: true)` from `std::agency` reports no errors. The generated import is `from "./notes.agency"`, which resolves against the directory the source is compiled in, so `dir` must be that directory.
- `noLimitsTypechecks(): boolean`: the meal plan without `limits`; the source has no `guard` and typechecks.
- `plainReturnHasNoValue(): boolean`: a workflow of `searchNotes` then `splitLines(text: steps.note[0].body)`, no `limits`; the source contains `if (step_lines is failure)` and `return success(step_lines)`, does not contain `step_lines.value`, and typechecks.
- `stepNamedFailureIsHarmless(): boolean`: the meal plan with the first step renamed `failure`; the source contains `const step_failure = searchNotes(` and typechecks.
- `literalIsNeverCode(): boolean`: `query: "${evil} \"\"\" }"`; `compile(source, DIR, strict: true)` succeeds and the source contains `const step_note_query = "\${evil} \"\"\" }"` (what the printer printed on 2026-10-27).
- `typeTextCannotSmuggle(): string`: `inputs: "{ a: string }\nexport node evil() { return 1 }"`; returns the first problem's `field + ": " + message`, expected `"inputs: inputs must be one object type"`.
- `isDeterministic(): boolean`.

`compile.test.json`: exact `true` for the booleans, exact string for `typeTextCannotSmuggle`.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm run agency test tests/agency/workflow/compile.agency > /tmp/wf-t7.txt 2>&1; tail -20 /tmp/wf-t7.txt`
Expected: FAIL, `std::workflow` not found.

- [ ] **Step 3: Implement `index.ts`, then `stdlib/workflow.agency`**

Add `index.test.ts` with one test: `compileWorkflowSource(mealPlan, mealRefs, mealSignatures)` returns a source equal to a checked-in expected string (write it on first run, read it before committing). This is the one place the whole generated program is visible in a TypeScript test.

The module doc comment: the spec's "The problem" first paragraph, the two rules in one sentence each, and a four-line example calling `compileWorkflow` and printing the source.

- [ ] **Step 4: Build, run the test to verify it passes, format, typecheck, lint, commit**

Run: `make > /tmp/wf-make.txt 2>&1; tail -3 /tmp/wf-make.txt; pnpm run agency test tests/agency/workflow/compile.agency > /tmp/wf-t7.txt 2>&1; tail -20 /tmp/wf-t7.txt; pnpm run typecheck > /tmp/wf-tc.txt 2>&1; tail -3 /tmp/wf-tc.txt; pnpm run lint:structure > /tmp/wf-lint.txt 2>&1; tail -3 /tmp/wf-lint.txt`
Expected: 9 passed, and the three checks clean.

```bash
git add lib/stdlib/workflow/index.ts lib/stdlib/workflow/index.test.ts stdlib/workflow.agency tests/agency/workflow/ docs/site/stdlib/workflow.md
git commit -F - <<'EOF'
workflow: compileWorkflow renders a workflow as an Agency program

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 8: `checkWorkflow`

**Files:**
- Modify: `stdlib/workflow.agency`
- Create: `tests/agency/workflow/check.agency`, `check.test.json`

**Interfaces:**
- Produces: `export def checkWorkflow(workflow: Workflow, tools: any[], dir: string = ""): Result<WorkflowProblem[], { problems: WorkflowProblem[] }>`. A success carries the warnings (empty when none). A failure carries the problems. Order: `_compileWithRanges` (its problems are returned as is), then `compile(source, dir, strict: true)` (a failure becomes one problem with no owner), then `typecheck(source, dir: dir, strict: true)`; its errors go through `_problemsFromDiagnostics`; its warnings are not reported.

- [ ] **Step 1: Write the failing Agency test**

- `cleanWorkflowHasNoProblems(): boolean`.
- `badPathNamesStepAndArgument(): string`: `readNote`'s `id` references `steps.note[0].title2`; returns `problems[0].step + "/" + problems[0].field`, expected `"text/args.id"`.
- `wrongArgumentNameNamesTheArgument(): string`: `searchNotes` called with `querry`; expected `"note/args.querry"`.
- `unknownToolIsRefusedBeforeCompile(): string`: `module: "std::shell", tool: "bash"` with the stub tools; expected message contains `not among the tools passed`.
- `forwardReferenceIsRefused(): string`: expected `"note/args.query"` with message containing `comes after`.
- `noReturnTypeIsAWarning(): string`: add `export def untyped(q: string) { return [q] }` to `notes.agency`; a workflow calling it then referencing `steps.u[0]`; `checkWorkflow` succeeds and `warnings[0].step` is `"u"`.

- [ ] **Step 2: Run it to verify it fails; implement; build; run to verify it passes; typecheck; lint; commit**

Run: `make > /tmp/wf-make.txt 2>&1; tail -3 /tmp/wf-make.txt; pnpm run agency test tests/agency/workflow/check.agency > /tmp/wf-t8.txt 2>&1; tail -20 /tmp/wf-t8.txt`
Expected: 6 passed.

```bash
git add stdlib/workflow.agency tests/agency/workflow/ docs/site/stdlib/workflow.md
git commit -F - <<'EOF'
workflow: checkWorkflow reports every problem by step and field

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 9: Dev doc, indexes, and the checks before a PR

**Files:**
- Create: `docs/dev/stdlib/workflow.md`
- Modify: `CLAUDE.md` (stdlib index, after `toolbox.md`), `.claude/skills/agency-stdlib-docs/SKILL.md` (same line), `docs/site/.vitepress/config.mts` (between `weather` and `wikipedia`)

- [ ] **Step 1: Write the dev doc**

Mechanism and rules only. Sections: what a workflow is and the two rules (pointing at the spec); the four stages and the file for each; the three doors text enters by (a lifted value, a checked identifier, canonicalized type text) and the one text join that remains (the scaffold); why the scaffold is fixed text and not a template (hygiene renames a parameter the filler mentions), and the two naming rules in resolve that keep hygiene from renaming anything else; why return types come from `describe` and what a tool typed `any` gets; the per-argument local and why (one line per field, so a type error maps to the field); the line ranges from per-fragment prints and the payload rule; what is not here yet (running, the tool wrapper, the catalog, saving) with the spec section for each.

- [ ] **Step 2: Add the index lines and the sidebar entry**

`CLAUDE.md` line: `` `docs/dev/stdlib/workflow.md` — `std::workflow`: a JSON step list compiled to an Agency program through parse, resolve, lower, and render; the three doors text enters by, why the scaffold is fixed text and the two naming rules that keep template hygiene from renaming a binder, why return types come from `describe`, one local per argument, the line ranges from per-fragment prints, and the payload rule for diagnostics. ``

- [ ] **Step 3: Run every check, saving output**

```bash
pnpm run typecheck > /tmp/wf-final-tc.txt 2>&1; tail -3 /tmp/wf-final-tc.txt
pnpm run lint:structure > /tmp/wf-final-lint.txt 2>&1; tail -3 /tmp/wf-final-lint.txt
npx prettier --check lib/stdlib/workflow lib/stdlib/agency.ts > /tmp/wf-final-fmt.txt 2>&1; tail -3 /tmp/wf-final-fmt.txt
npx vitest run lib/stdlib/workflow lib/stdlib/agency > /tmp/wf-final-vitest.txt 2>&1; tail -5 /tmp/wf-final-vitest.txt
for f in tests/agency/workflow/*.agency; do pnpm run agency test "$f" >> /tmp/wf-final-agency.txt 2>&1; done; grep -E "passed|failed" /tmp/wf-final-agency.txt
```

Expected: every command exits 0; every Agency test file reports all cases passed.

- [ ] **Step 4: Audit the diff against `docs/dev/contributing/anti-patterns.md` and fix what it finds**

- [ ] **Step 5: Commit, then open the PR with a description written to a file first, ending with the attribution line, and stop**

```bash
git add docs/dev/stdlib/workflow.md CLAUDE.md .claude/skills/agency-stdlib-docs/SKILL.md docs/site/.vitepress/config.mts
git commit -F - <<'EOF'
workflow: dev doc and index lines

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

## Self-review

**Spec coverage, for this part.** The format and references: Task 2. Tools and the allow-list, partial and rename refusal: Tasks 3 and 4. Return types through `describe`: Tasks 1 and 4. The three doors for text: Tasks 2, 3, 5, and 6. Hygiene, the fixed scaffold, and the naming rules: Tasks 4, 6, and 7. Results unwrapping: Tasks 4 and 5. The line map and the payload rule: Task 6. `compileWorkflow` and `checkWorkflow`: Tasks 7 and 8. Determinism: Tasks 5, 6, and 7. Not in this part, by the owner's decision: `runWorkflow`, `workflowTool`, `workflowTools`, `catalog`, save and load, the `run`, `scan`, and `save` effects, and the `withParamSchema` registry entry. The dev doc says so.

**Spec alignment.** The spec's sections 2 to 4, "Results", "Tools and modules", and the generated-program example were updated on 2026-10-27 to match this plan: fragments from a shapes table, three doors for text, the fixed scaffold and the hygiene reason, `step_` names, the check after every tool step, `return success(...)`, and the module id translation.

**Step scan.** Each test step names its assertions; each code step names its signature and file; no step says "handle edge cases".

**Type consistency.** `Problem`, `Workflow`, `ToolRef`, `Signature`, `ResolvedWorkflow`, `Owner`, `Fragment`, `TypeDecl`, `Lowered`, `Range` are each defined once in `types.ts`; `RenderResult` in `render.ts` and `Compiled` in `index.ts`; each is used by that name in every later task. The Agency `WorkflowProblem` mirrors `Problem`.

**Review Focus.** Each of the six lines names its task, and that task's test list has the case.

**Proportion.** The plan is about the length of the spec's generator section plus its format section. Code blocks are tests, type definitions, and the one template.
