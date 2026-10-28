/**
 * Stage 4 of the workflow generator: fragments become source text, and the
 * line ranges that say which step owns which lines come from the same
 * prints. Each fragment is printed once; the body is those prints joined,
 * so the counts cannot disagree with the text.
 */
import { AgencyGenerator } from "../../backends/agencyGenerator.js";
import type { AgencyNode } from "../../types.js";
import { _parseAST } from "../agency.js";
import { _toSource, type Code } from "../template.js";
import { literal } from "./shapes.js";
import type { Fragment, Limits, Lowered, Problem, Range, TypeDecl } from "./types.js";

export type RenderResult =
  | { source: string; ranges: Range[]; problems: [] }
  | { source: null; ranges: []; problems: Problem[] };

/** The shape of every generated program. Fixed text, not a template: filling
 *  a hole inside `node main(inputs: Inputs)` with statements that mention
 *  `inputs` would rename the parameter (template hygiene). */
const SCAFFOLD = `import { Json } from "std::validation"
{{imports}}

{{types}}

export node main(inputs: Inputs): Result {
{{body}}
}

export node inputsSchema(): Json {
  return schema(Inputs).toJSONSchema()
}
`;

const GUARDED_SCAFFOLD = `import { Json } from "std::validation"
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
`;

const INDENT = "  ";
const TOKEN = /\{\{(imports|types|guardArgs|body)\}\}/g;
const BODY_TOKEN = "{{body}}";

/** Parsing type text records blank lines as nodes; they are not declarations. */
const IGNORED_NODES = ["newLine"];

/** The declaration `describe` would print for `type <name> = <text>`, or null
 *  when the text is not exactly one type. This is `describe`'s parse and
 *  printer without its effects pass, which could resolve an import written
 *  into the text. */
function canonicalType(decl: TypeDecl): string | null {
  let nodes: AgencyNode[];
  try {
    nodes = _parseAST(`type ${decl.name} = ${decl.text}`).nodes;
  } catch {
    // The text does not parse as a type: the caller reports it as a problem.
    return null;
  }
  const declarations = nodes.filter((node) => !IGNORED_NODES.includes(node.type));
  const [alias] = declarations;
  if (declarations.length !== 1 || alias.type !== "typeAlias" || alias.aliasName !== decl.name) {
    return null;
  }
  if (decl.owner === null && alias.aliasedType.type !== "objectType") {
    return null;
  }
  return new AgencyGenerator().signatureOf(alias);
}

/** `Inputs` has no step; an llm output type belongs to its step's `output`. */
function typeProblem(decl: TypeDecl): Problem {
  if (decl.owner === null) {
    return { step: null, field: "inputs", message: "inputs must be one object type" };
  }
  return {
    step: decl.owner.step,
    field: decl.owner.field,
    message: `${decl.owner.field} must be one type`,
  };
}

function numberText(value: number): string {
  return _toSource(literal(value)).trim();
}

function guardArgs(limits: Limits): string {
  const time = limits.maxTime === undefined ? [] : [`time: ${numberText(limits.maxTime)}`];
  const cost = limits.maxCost === undefined ? [] : [`cost: ${numberText(limits.maxCost)}`];
  return [...time, ...cost].join(", ");
}

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

/** Fragment `i` covers the lines after fragment `i - 1`; one without an
 *  owner takes its lines and produces no range. */
function rangesOf(prints: string[][], body: Fragment[], firstLine: number): Range[] {
  const starts = prints.reduce<number[]>(
    (acc, lines, index) => [...acc, acc[index] + lines.length],
    [firstLine],
  );
  return body.flatMap((fragment, index) => {
    const owner = fragment.owner;
    return owner === null ? [] : [{ from: starts[index], to: starts[index + 1] - 1, owner }];
  });
}

export function renderWorkflow(lowered: Lowered): RenderResult {
  const types = lowered.types.map((decl) => ({ decl, line: canonicalType(decl) }));
  const problems = types.filter(({ line }) => line === null).map(({ decl }) => typeProblem(decl));
  if (problems.length > 0) {
    return { source: null, ranges: [], problems };
  }
  const limits = lowered.guard;
  const args = limits === null ? "" : guardArgs(limits);
  const scaffold = args === "" ? SCAFFOLD : GUARDED_SCAFFOLD;
  const depth = args === "" ? 1 : 2;
  const prints = lowered.body.map((fragment) => printLines(fragment.code));
  const resultLines = printLines(lowered.result);
  resultLines[0] = `return success(${resultLines[0]}`;
  resultLines[resultLines.length - 1] += ")";
  const bodyLines = [...prints.flat(), ...resultLines];

  const values = {
    imports: lowered.imports.join("\n"),
    types: types.map(({ line }) => line).join("\n"),
    guardArgs: args,
    body: indent(bodyLines, depth).join("\n"),
  };
  const bodyAt = scaffold.indexOf(BODY_TOKEN);
  const head = substitute(scaffold.slice(0, bodyAt), values);
  const source = head + substitute(scaffold.slice(bodyAt), values);
  const firstLine = head.split("\n").length;
  return { source, ranges: rangesOf(prints, lowered.body, firstLine), problems: [] };
}
