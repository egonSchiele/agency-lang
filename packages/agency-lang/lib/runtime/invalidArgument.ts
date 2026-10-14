import { isFailure } from "./result.js";
import type { ResultFailure } from "./result.js";

/**
 * The failure a function returns when a validated (`!`) parameter does not
 * fit its type. A model that calls the function as a tool reads this message
 * and has to correct its next call from it, so the message names the
 * argument, says what type it takes, and says what arrived:
 *
 *   Argument "value" of logEntry must be number | null, but received the
 *   text "None". To leave it empty, send null, not text.
 *
 * The schema library's own message is a JSON list of issues that never
 * names the argument.
 */

// The longest piece of a received text value quoted back in the message.
const QUOTED_TEXT_LIMIT = 60;

// Words a model writes when it means "no value" but sends text.
const EMPTY_WORDS = ["none", "null", "nil", "undefined"];

export type InvalidArgument = {
  functionName: string;
  paramName: string;
  // The parameter's declared type, as the author wrote it.
  typeText: string;
  // The value the caller sent.
  value: unknown;
  // What validation returned for it.
  failure: ResultFailure;
};

type IssuePath = (string | number)[];

type SchemaIssue = {
  code: string;
  path: IssuePath;
  message: string;
  // The literal values that would have been accepted, on an `invalid_value`
  // issue.
  values?: unknown[];
  // One list of issues per option, on an `invalid_union` issue. Their paths
  // start at the union's own position.
  errors?: SchemaIssue[][];
};

// One thing wrong inside the value. `path` is empty when the problem is
// with the value as a whole.
type Problem = {
  path: IssuePath;
  message: string;
};

function quoted(text: string): string {
  if (text.length <= QUOTED_TEXT_LIMIT) {
    return JSON.stringify(text);
  }
  return `${JSON.stringify(text.slice(0, QUOTED_TEXT_LIMIT))}...`;
}

export function describeValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return `the text ${quoted(value)}`;
  }
  if (typeof value === "number") {
    return `the number ${value}`;
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return "a list";
  }
  return "an object";
}

/** The schema library's issues, when a failure message is its JSON list of
 *  them, or null when the message came from a `@validate` function. */
function schemaIssues(message: string): SchemaIssue[] | null {
  if (!message.startsWith("[")) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch (_notJson) {
    // A validator's own message that happens to start with a bracket.
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  if (!parsed.every(isIssue)) {
    return null;
  }
  return parsed as SchemaIssue[];
}

/** True when `item` has the shape of one schema-library issue, including
 *  the issues nested inside a union's options. */
function isIssue(item: any): boolean {
  if (item === null || typeof item !== "object") {
    return false;
  }
  if (!("code" in item) || !Array.isArray(item.path)) {
    return false;
  }
  if ("values" in item && !Array.isArray(item.values)) {
    return false;
  }
  if (!("errors" in item)) {
    return true;
  }
  return (
    Array.isArray(item.errors) &&
    item.errors.every((option: unknown) => Array.isArray(option) && option.every(isIssue))
  );
}

/** The value found by following `path` into `value`, or undefined when the
 *  path leads nowhere. Only the value's own fields count, so a missing
 *  `constructor` field is not read from the object's prototype. */
function valueAt(value: unknown, path: IssuePath): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) {
      return undefined;
    }
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

function isWholeValueIssue(issue: SchemaIssue): boolean {
  return issue.path.length === 0;
}

function isLiteralMismatchAt(issue: SchemaIssue, key: string | number): boolean {
  return issue.code === "invalid_value" && issue.path.length === 1 && issue.path[0] === key;
}

function uniqueValues(values: unknown[]): unknown[] {
  const encoded = values.map((value) => JSON.stringify(value));
  return values.filter((_value, index) => encoded.indexOf(encoded[index]) === index);
}

/** The problem for a value that is not the literal, or none of the
 *  literals, the type takes. */
function expectedLiterals(path: IssuePath, values: unknown[], root: unknown): Problem {
  const choices = uniqueValues(values).map((value) => JSON.stringify(value));
  const expected = choices.length === 1 ? choices[0] : `one of ${choices.join(", ")}`;
  const received = valueAt(root, path);
  const receivedText = received === undefined ? "" : `, but received ${describeValue(received)}`;
  return { path, message: `expected ${expected}${receivedText}` };
}

/** The literals of a union whose options are all literals, such as
 *  `"Mon" | "Tue"`, or null when some option is not a literal. */
function literalChoices(options: SchemaIssue[][]): unknown[] | null {
  const allLiterals = options.every(
    (option) =>
      option.length === 1 && option[0].code === "invalid_value" && isWholeValueIssue(option[0]),
  );
  if (!allLiterals) {
    return null;
  }
  return options.flatMap((option) => option[0].values ?? []);
}

/** The key that tells a union's object options apart, such as `type` in
 *  `{ type: "daily" } | { type: "monthly", day: number }`. A key qualifies
 *  when the value's field missed the literal in every option but at most one. */
function tagKey(options: SchemaIssue[][]): string | number | null {
  if (options.length < 2) {
    return null;
  }
  const keys = options.flatMap((option) =>
    option.filter((issue) => issue.code === "invalid_value" && issue.path.length === 1),
  );
  const tag = keys.find((candidate) => {
    const key = candidate.path[0];
    const missed = options.filter((option) =>
      option.some((issue) => isLiteralMismatchAt(issue, key)),
    );
    return missed.length >= options.length - 1;
  });
  return tag === undefined ? null : tag.path[0];
}

/** The problems with a value that fit none of a union's options. When one
 *  option is clearly the one the caller meant, its problems are reported.
 *  When the value picked no option, the problem says which choices exist. */
function unionProblems(issue: SchemaIssue, prefix: IssuePath, root: unknown): Problem[] {
  const path = [...prefix, ...issue.path];
  const options = issue.errors ?? [];
  const literals = literalChoices(options);
  if (literals !== null) {
    return [expectedLiterals(path, literals, root)];
  }
  // Options the value is the wrong kind for, such as null when an object
  // arrived, cannot be the one the caller meant.
  const fitting = options.filter((option) => !option.some(isWholeValueIssue));
  if (fitting.length === 1) {
    return problemsAt(fitting[0], path, root);
  }
  const tag = tagKey(fitting);
  if (tag === null) {
    // No option stands out, so only the union's own position is reported.
    return path.length === 0 ? [] : [{ path, message: issue.message }];
  }
  const matching = fitting.filter(
    (option) => !option.some((item) => isLiteralMismatchAt(item, tag)),
  );
  if (matching.length === 1) {
    return problemsAt(matching[0], path, root);
  }
  const tagValues = fitting.flatMap((option) =>
    option.filter((item) => isLiteralMismatchAt(item, tag)).flatMap((item) => item.values ?? []),
  );
  return [expectedLiterals([...path, tag], tagValues, root)];
}

/** The problems behind a list of issues whose paths start at `prefix`.
 *  An ordinary issue about the value as a whole is left out, because the
 *  message already says what kind of value arrived. */
function problemsAt(issues: SchemaIssue[], prefix: IssuePath, root: unknown): Problem[] {
  return issues.flatMap((issue) => {
    if (issue.code === "invalid_union" && issue.errors !== undefined && issue.errors.length > 0) {
      return unionProblems(issue, prefix, root);
    }
    const path = [...prefix, ...issue.path];
    if (path.length === 0) {
      return [];
    }
    if (issue.code === "invalid_value" && issue.values !== undefined) {
      return [expectedLiterals(path, issue.values, root)];
    }
    return [{ path, message: issue.message }];
  });
}

function formatProblem(problem: Problem): string {
  if (problem.path.length === 0) {
    return problem.message;
  }
  return `${problem.path.join(".")}: ${problem.message}`;
}

/** One sentence naming what inside the value did not fit, or nothing when
 *  the value as a whole is the wrong kind. */
function nestedProblems(issues: SchemaIssue[], value: unknown): string {
  const problems = problemsAt(issues, [], value);
  if (problems.length === 0) {
    return "";
  }
  return ` Problems: ${problems.map(formatProblem).join("; ")}.`;
}

function emptyHint(arg: InvalidArgument): string {
  if (typeof arg.value !== "string") {
    return "";
  }
  const allowsNull = arg.typeText.split("|").some((part) => part.trim() === "null");
  if (!allowsNull || !EMPTY_WORDS.includes(arg.value.trim().toLowerCase())) {
    return "";
  }
  return " To leave it empty, send null, not text.";
}

export function __invalidArgument(arg: InvalidArgument): ResultFailure {
  if (isFailure(arg.value)) {
    // The caller passed in a failure from an earlier step. Validation hands
    // it back untouched, and so does this: the argument was not refused.
    return arg.failure;
  }
  const named = `Argument "${arg.paramName}" of ${arg.functionName}`;
  const issues = schemaIssues(arg.failure.error);
  if (issues === null) {
    // The value fits the type, and a `@validate` function refused it. Its
    // message is written by the function's author, so it goes through.
    return { ...arg.failure, error: `${named} was refused: ${arg.failure.error}` };
  }
  const message =
    `${named} must be ${arg.typeText}, but received ${describeValue(arg.value)}.` +
    nestedProblems(issues, arg.value) +
    emptyHint(arg);
  return { ...arg.failure, error: message };
}
