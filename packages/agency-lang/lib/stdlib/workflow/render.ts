/**
 * Stage 4 of the workflow generator: fragments become source text, and the
 * line ranges that say which step owns which lines come from the same
 * prints. Each fragment is printed once; the body is those prints joined,
 * so the counts cannot disagree with the text.
 */
import { _toSource, type Code } from "../template.js";
import { guardArgs } from "./shapes.js";
import { parseTypeText, printType } from "./typeText.js";
import type { Lowered, Owner, Range, TypeDecl } from "./types.js";

export type RenderResult = { source: string; ranges: Range[]; typeOwners: Record<string, Owner> };

/** The shape of every generated program. Fixed text, not a template: filling
 *  a hole inside `node main(inputs: Inputs)` with statements that mention
 *  `inputs` would rename the parameter (template hygiene). `inputsSchema`
 *  asks for the input form: a key with a default is optional there, so an
 *  optional input is optional in the tool a workflow becomes.
 *
 *  The handler around the body is what makes every limit hard. A guard trip
 *  raises `std::guard`, and an approval would give the guard more budget.
 *  The handler rejects a trip from the workflow's own guards, the one around
 *  the body and each step's, and a rejection wins over any approval. So no
 *  caller can extend the workflow's limits or a step's.
 *
 *  It passes on every other trip, as the `@guarded` decorator does. A tool's
 *  own guard sits inside the step's guard and the workflow's, so a caller
 *  who extends it is still stopped at the workflow's limits. And a tool that
 *  extends its own guard, as `supervise()` does, keeps working. A tool guard
 *  whose label matches a step id is rejected too, which is the safe way for
 *  a collision to go. */
const SCAFFOLD = `import { Json } from "std::validation"
{{imports}}

{{types}}

export node main(inputs: Inputs!): Result {
  handle {
{{body}}
  } with (guardTrip) {
    if (guardTrip.effect == "std::guard" && {{guardLabels}}.includes(guardTrip.data.label)) {
      return reject()
    }
    return pass()
  }
}

export node inputsSchema(): Json {
  return schema(Inputs).toJSONSchema("input")
}
`;

/** SCAFFOLD with the workflow's own limits as a guard, inside the same handler. */
const GUARDED_SCAFFOLD = `import { Json } from "std::validation"
{{imports}}

{{types}}

export node main(inputs: Inputs!): Result {
  handle {
    return guard(label: {{guardLabel}}, {{guardArgs}}) {
{{body}}
    }
  } with (guardTrip) {
    if (guardTrip.effect == "std::guard" && {{guardLabels}}.includes(guardTrip.data.label)) {
      return reject()
    }
    return pass()
  }
}

export node inputsSchema(): Json {
  return schema(Inputs).toJSONSchema("input")
}
`;

const INDENT = "  ";
const TOKEN = /\{\{(imports|types|guardArgs|guardLabel|guardLabels|body)\}\}/g;
const BODY_TOKEN = "{{body}}";
const TYPES_TOKEN = "{{types}}";

function printLines(code: Code): string[] {
  return _toSource(code).replace(/\n$/, "").split("\n");
}

function indent(lines: string[], depth: number): string[] {
  return lines.map((line) => (line === "" ? line : INDENT.repeat(depth) + line));
}

/** One pass over the text, so no replacement is searched for another token,
 *  and a function replacer, so a `$` in a print is never replacement syntax. */
function substitute(text: string, values: Record<string, string>): string {
  return text.replace(TOKEN, (_match, token: string) => values[token]);
}

/** The line a token's first line of text lands on. */
function lineOf(scaffold: string, token: string, values: Record<string, string>): number {
  return substitute(scaffold.slice(0, scaffold.indexOf(token)), values).split("\n").length;
}

/** A run of consecutive lines and who owns them. */
type Block = { lines: number; owner: Owner | null };

/** Block `i` covers the lines after block `i - 1`; one without an owner takes
 *  its lines and produces no range. */
function rangesOf(blocks: Block[], firstLine: number): Range[] {
  const starts = blocks.reduce<number[]>(
    (acc, block, index) => [...acc, acc[index] + block.lines],
    [firstLine],
  );
  return blocks.flatMap(({ owner }, index) =>
    owner === null ? [] : [{ from: starts[index], to: starts[index + 1] - 1, owner }],
  );
}

const RESULT_OWNER: Owner = { step: null, field: "result" };

/** The declaration line for a type parse already accepted. */
function typeLine(decl: TypeDecl): string {
  const parsed = parseTypeText(decl.name, decl.text, decl.owner.field ?? decl.name);
  if ("message" in parsed) {
    throw new Error(`type text reached render unchecked: ${parsed.message}`);
  }
  return printType(parsed.alias);
}

export function renderWorkflow(lowered: Lowered): RenderResult {
  const typeLines = lowered.types.map(typeLine);
  const limits = lowered.guard;
  const args = limits === null ? "" : guardArgs(limits).join(", ");
  const scaffold = args === "" ? SCAFFOLD : GUARDED_SCAFFOLD;
  const depth = args === "" ? 2 : 3;
  const prints = lowered.body.map((fragment) => printLines(fragment.code));
  const resultLines = printLines(lowered.result);
  resultLines[0] = `return success(${resultLines[0]}`;
  resultLines[resultLines.length - 1] += ")";

  const values = {
    imports: lowered.imports.join("\n"),
    types: typeLines.join("\n"),
    guardArgs: args,
    // Labels are the workflow's name and step ids, which parse proved are
    // identifiers, so JSON writes them as plain Agency string literals.
    guardLabel: JSON.stringify(lowered.guardLabel),
    guardLabels: JSON.stringify(lowered.guardLabels),
    body: indent([...prints.flat(), ...resultLines], depth).join("\n"),
  };
  const typeBlocks = lowered.types.map((decl, index) => ({
    lines: typeLines[index].split("\n").length,
    owner: decl.owner,
  }));
  const bodyBlocks = [
    ...prints.map((lines, index) => ({ lines: lines.length, owner: lowered.body[index].owner })),
    { lines: resultLines.length, owner: RESULT_OWNER },
  ];
  const ranges = [
    ...rangesOf(typeBlocks, lineOf(scaffold, TYPES_TOKEN, values)),
    ...rangesOf(bodyBlocks, lineOf(scaffold, BODY_TOKEN, values)),
  ];
  const typeOwners = Object.fromEntries(lowered.types.map((decl) => [decl.name, decl.owner]));
  return { source: substitute(scaffold, values), ranges, typeOwners };
}
