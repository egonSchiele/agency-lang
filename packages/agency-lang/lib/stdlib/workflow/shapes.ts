/**
 * The shapes of the statements a workflow generates, and the one way to
 * turn a shape into a fragment.
 *
 * A `{{name}}` token takes a name. It is replaced only after the
 * replacement passes the parser's identifier check (or, for `args` and
 * `options`, the check for that token's fixed form), so no workflow text
 * becomes code through it. A `#name` hole takes a value: a `Code` fragment
 * this generator built, or a workflow value passed through `literal`, which
 * lifts it to a literal node and never parses it.
 */
import { liftValue } from "../../runtime/template/lift.js";
import { _fill, _parseExpr, _parseStatements, _toSource, type Code } from "../template.js";
import { isIdentifier, type Limits } from "./types.js";

export const SHAPES = {
  binding: "const {{local}} = #value",
  call: "const {{value}} = {{tool}}({{args}})",
  check:
    'if ({{value}} is failure) {\n  return failure("step {{id}} ({{tool}}): ${{{value}}.error}", { step: #id, cause: {{value}} })\n}',
  // For a tool whose declared type is not a Result: the value can still be
  // a failure, but its type has no `.error`, so the message reads it through
  // a cast.
  checkPlain:
    'if ({{value}} is failure) {\n  return failure("step {{id}} ({{tool}}): ${({{value}} as any).error}", { step: #id, cause: {{value}} })\n}',
  // An LLM step. A thread block's value is its message list, and a `return`
  // inside one returns from the enclosing function. So an unguarded step
  // declares its local first (`letNull`) and assigns it inside the block,
  // while a guarded step returns the reply from the block, which returns
  // from the guard. `{{after}}` is that last line, as text: a hole filled
  // with code that names the reply would make hygiene rename the binder.
  // The reply is a typed `const` of its own, because only the type on an
  // `llm()` call's declaration gives it a structured-output schema. The cast
  // on `null` is the one way to declare a `let` of the output type with no
  // value yet.
  letNull: "let {{value}}: {{outputType}} = null as {{outputType}}",
  llmThread:
    "thread {\n  const {{reply}}: {{outputType}} = llm(#prompt{{options}})\n  {{after}}\n}",
  // A step with limits: its call or thread runs inside a guard named after
  // the step. `#body` is a statements hole, so a body of several statements
  // spreads into the block.
  guarded: "const {{value}} = guard(label: #label{{limits}}) {\n  #body\n}",
  returnCall: "return {{tool}}({{args}})",
  // What the model reads for a context value: a string as itself, anything else as JSON.
  contextText:
    "const {{local}} = if {{value}} is string then {{value}} else JSON.stringify({{value}})",
  concat: "#left + #right",
  local: "{{name}}",
} as const;

export type Shape = keyof typeof SHAPES;

const TOKEN = /\{\{(\w+)\}\}/g;

/** The llm options a shape may name, in the order they are written. */
const MODEL_OPTION = ", model: #model";
const PROVIDER_OPTION = ", provider: #provider";
const OPTION_FORMS = ["", MODEL_OPTION, PROVIDER_OPTION, MODEL_OPTION + PROVIDER_OPTION];

/** `name: local, name: local`, each side an identifier, or nothing. */
function isArgList(text: string): boolean {
  if (text === "") {
    return true;
  }
  return text.split(", ").every((pair) => {
    const sides = pair.split(": ");
    return sides.length === 2 && sides.every(isIdentifier);
  });
}

/** The limit pieces a guard line takes, time first, each number printed as
 *  a literal. The one place a limit becomes code, for the workflow guard
 *  (render joins the pieces) and a step guard (lower prefixes each with `, `). */
export function guardArgs(limits: Limits): string[] {
  const time = limits.maxTime === undefined ? [] : [`time: ${numberText(limits.maxTime)}`];
  const cost = limits.maxCost === undefined ? [] : [`cost: ${numberText(limits.maxCost)}`];
  return [...time, ...cost];
}

function numberText(value: number): string {
  return _toSource(literal(value)).trim();
}

/** Nothing, or `, ` then pieces as `guardArgs` prints them: `time: <n>` or
 *  `cost: <n>`, joined by `, `, each `<n>` a finite number. */
function isLimitList(text: string): boolean {
  if (text === "") {
    return true;
  }
  if (!text.startsWith(", ")) {
    return false;
  }
  return text
    .slice(2)
    .split(", ")
    .every((piece) => {
      const sides = piece.split(": ");
      return (
        sides.length === 2 &&
        ["time", "cost"].includes(sides[0]) &&
        Number.isFinite(Number(sides[1])) &&
        sides[1].trim() === sides[1]
      );
    });
}

/** `return <name>` or `<name> = <name>`, each name an identifier. */
function isAfterLine(text: string): boolean {
  const returned = /^return (\S+)$/.exec(text);
  if (returned !== null) {
    return isIdentifier(returned[1]);
  }
  const sides = text.split(" = ");
  return sides.length === 2 && sides.every(isIdentifier);
}

const TOKEN_CHECKS: Record<string, (text: string) => boolean> = {
  args: isArgList,
  options: (text) => OPTION_FORMS.includes(text),
  limits: isLimitList,
  after: isAfterLine,
};

function substitute(shape: Shape, names: Record<string, string>): string {
  return SHAPES[shape].replace(TOKEN, (_match, token: string) => {
    const text = names[token];
    const check = TOKEN_CHECKS[token] ?? isIdentifier;
    if (text === undefined || !check(text)) {
      throw new Error(`shape "${shape}": {{${token}}} cannot be ${JSON.stringify(text)}`);
    }
    return text;
  });
}

/** Lifted workflow values carry no source position of their own. */
const NO_POSITION = { line: 0, col: 0, start: 0, end: 0 };

/** A workflow value as a literal fragment. Lifting it here, before any
 *  `fill`, means a value shaped like a `Code` fragment is still data. */
export function literal(value: unknown): Code {
  return { type: "agencyProgram", kind: "expr", nodes: [liftValue(value, NO_POSITION)] };
}

export function statement(
  shape: Shape,
  names: Record<string, string>,
  values: Record<string, Code>,
): Code {
  return _fill(_parseStatements(substitute(shape, names)), values);
}

export function expression(
  shape: Shape,
  names: Record<string, string>,
  values: Record<string, Code>,
): Code {
  return _fill(_parseExpr(substitute(shape, names)), values);
}

/** A list literal whose items are holes named by position. */
export function list(items: Code[]): Code {
  const holes = items.map((_item, index) => `#item${index}`);
  const values = Object.fromEntries(items.map((item, index) => [`item${index}`, item]));
  return _fill(_parseExpr(`[${holes.join(", ")}]`), values);
}

export type RecordEntry = { key: string; value: Code };

/** An object literal whose keys are identifiers and whose values are holes
 *  named by position. */
export function record(entries: RecordEntry[]): Code {
  const fields = entries.map(({ key }, index) => {
    if (!isIdentifier(key)) {
      throw new Error(`record key "${key}" is not an identifier`);
    }
    return `${key}: #entry${index}`;
  });
  const values = Object.fromEntries(entries.map(({ value }, index) => [`entry${index}`, value]));
  return _fill(_parseExpr(`{ ${fields.join(", ")} }`), values);
}
