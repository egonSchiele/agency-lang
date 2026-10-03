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

type SchemaIssue = {
  path: (string | number)[];
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
  const isIssue = (item: any) =>
    item !== null && typeof item === "object" && "code" in item && Array.isArray(item.path);
  if (!parsed.every(isIssue)) {
    return null;
  }
  return parsed as SchemaIssue[];
}

/** One sentence naming the fields inside the value that did not fit, or
 *  nothing when the value as a whole is the wrong kind. */
function nestedProblems(issues: SchemaIssue[]): string {
  const nested = issues.filter((issue) => issue.path.length > 0);
  if (nested.length === 0) {
    return "";
  }
  const lines = nested.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  return ` Problems: ${lines.join("; ")}.`;
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
    nestedProblems(issues) +
    emptyHint(arg);
  return { ...arg.failure, error: message };
}
