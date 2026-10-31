import { isPlainObject } from "../config/paths.js";
import type { Host } from "../host/host.js";
import { currentRun } from "../runtime/asyncContext.js";
import { currentHost } from "../runtime/currentHost.js";
import { findOutputSource } from "../runtime/toolOutputStore.js";
import { stripControlCharacters } from "../utils/controlCharacters.js";
import { formatElapsed } from "../utils/formatElapsed.js";
import { color, plainColor, RESET } from "../utils/termcolors.js";
import { stripAnsi, visualWidth, wrapText } from "./layout/ansi.js";

/** The source of a saved output, by its name; null when unknown. */
export type SpillLookup = (name: string) => string | null;
export type TraceOptions = {
  columns: number;
  color: boolean;
  /** Append the registered tool name to summary lines (debug mode). */
  toolNames?: boolean;
  spillSource?: SpillLookup;
};
export type ToolStartEvent = {
  kind: "toolStart";
  toolName: string;
  args: unknown;
  provider?: string | null;
};
export type ToolEndEvent = {
  kind: "toolEnd";
  toolName: string;
  args?: unknown;
  value: unknown;
  outcome: "success" | "failure" | "plain";
  /** Milliseconds the call took. */
  timeTaken?: number;
  provider?: string | null;
};
export type HostedSearchEvent = { kind: "hostedSearch"; result: unknown };
export type AgentStartEvent = {
  kind: "agentStart";
  toolName: string;
  message: string;
};
export type SessionSaveFailureEvent = { kind: "sessionSaveFailure"; message: string };
export type AgentTraceEvent =
  ToolStartEvent | ToolEndEvent | HostedSearchEvent | AgentStartEvent | SessionSaveFailureEvent;

type TraceStyle = "heading" | "muted" | "completed" | "active" | "success" | "error" | "warning";
type TraceSpan = { text: string; style?: TraceStyle; bold?: boolean; limit?: number };
type TraceRow = { spans: TraceSpan[]; marker?: TraceSpan };
type TraceBlock = { heading: TraceSpan[]; rows: TraceRow[] };
type ToolEvent = ToolStartEvent | ToolEndEvent;
type TaskPresentation = { kind: "tasks"; heading: TraceSpan };
type AgentPresentation = { kind: "agent"; label: string };
/** A tool that prints nothing: its interrupt prompt or its own output is the display. */
type SilentPresentation = { kind: "silent" };
export type ToolArgs = Record<string, unknown>;
/** The parts shown after a summary label, built from the call's arguments. A null part is skipped. */
type ShowParts = (args: ToolArgs, lookup: SpillLookup) => (string | null)[];
/** An array result as "12 matches" (singular for one). */
type CountSummary = { count: string };
/** A command object: "exit N", red when N is not 0, output under the line. */
type ExitCodeSummary = { exitCode: true };
type CustomSummary = {
  custom: (value: unknown, args: ToolArgs) => string | null;
  /** The result counts as a failure (red mark) even on a success. */
  failsWhen?: (value: unknown) => boolean;
  /** Text printed under the line. */
  detail?: (value: unknown) => string | null;
};
type ResultSummary =
  "none" | "verdict" | "preview" | CountSummary | ExitCodeSummary | CustomSummary;
/** What a failure message adds to the line and prints under it; null to print the message as is. */
type FailureSummary = (message: string) => { line: string | null; detail: string | null } | null;
/** One line per call: `<mark> <label> <parts> · <result> · <elapsed>`. */
type SummaryPresentation = {
  kind: "summary";
  label: string;
  show: ShowParts;
  /** A start line when the call begins and an end line when it settles. */
  twoLines: boolean;
  result: ResultSummary;
  failure?: FailureSummary;
};
type ToolPresentation =
  TaskPresentation | AgentPresentation | SilentPresentation | SummaryPresentation;
type SearchSource = { url: string; title?: string };
type SearchPhase = "started" | "completed" | "reported" | "failed";
type SearchDescription = {
  toolName: string;
  provider: string;
  phase: SearchPhase;
  queries?: string[];
  sources?: SearchSource[] | null;
  error?: string;
};

const DEFAULT_COLUMNS = 80;
/** A two-line tool shows how long it took from this many milliseconds. */
const ELAPSED_FROM_MS = 1000;
const KILOBYTE = 1000;
/** A spill notice starts with this; only its first line is for a human. */
const SPILL_NOTICE_PREFIX = "[Output";
const ARGUMENT_PREVIEW_LENGTH = 50;
const RESULT_PREVIEW_LENGTH = 100;
const SOURCE_PREVIEW_COUNT = 5;
const TAB_WIDTH = 4;
const BODY_PREFIX = "  │ ";
const HEADING_CONTINUATION = "  ";

const OUTCOMES: Record<ToolEndEvent["outcome"], TraceSpan> = {
  success: { text: "✓ Tool finished", style: "success" },
  failure: { text: "✗ Tool failed", style: "error" },
  plain: { text: "✓ Tool finished", style: "success" },
};

// ---- The parts of a summary line ------------------------------------------

/** The first line of a value, with an ellipsis when more followed. */
function firstLineOf(value: string): string {
  const [first, ...rest] = value.split("\n");
  return rest.length === 0 ? first : `${first}…`;
}

/** A value as one piece of a line: a string, a number, or a string array
 *  joined by spaces. Anything else, or an empty string, is skipped. */
export function text(value: unknown): string | null {
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value === "" ? null : firstLineOf(value);
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.length === 0 ? null : firstLineOf(value.join(" "));
  }
  return null;
}

export function prefixed(prefix: string, value: unknown): string | null {
  const shown = text(value);
  return shown === null ? null : prefix + shown;
}

/** `dir/filename`, with `dir` dropped when it is missing or `.`. */
export function filePath(args: ToolArgs): string | null {
  const filename = text(args.filename);
  if (filename === null) return null;
  const dir = typeof args.dir === "string" ? args.dir : "";
  if (dir === "" || dir === ".") return filename;
  return `${dir.replace(/\/+$/, "")}/${filename}`;
}

/** The lines a read covered, by the `sliceLines` rule: `offset` is the
 *  1-based first line and `limit` a count, each 0 when unset. */
export function lineRange(args: ToolArgs): string | null {
  const offset = typeof args.offset === "number" && args.offset > 0 ? args.offset : 0;
  const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : 0;
  if (offset === 0 && limit === 0) return null;
  const start = offset === 0 ? 1 : offset;
  const end = limit === 0 ? "end" : String(start + limit - 1);
  return `lines ${start}–${end}`;
}

/** `baseUrl` with `path` appended when the call set one. */
export function urlWithPath(args: ToolArgs): string | null {
  const base = text(args.baseUrl);
  if (base === null) return null;
  return base + (text(args.path) ?? "");
}

/** `word` when the boolean argument is true. */
export function flag(args: ToolArgs, key: string, word: string): string | null {
  return args[key] === true ? word : null;
}

/** `output of <source>` for a saved output the store knows, else the name. */
export function spillOutput(name: unknown, lookup: SpillLookup): string | null {
  if (typeof name !== "string" || name === "") return null;
  const source = lookup(name);
  return source === null ? name : `output of ${source}`;
}

/** What a command printed, for a human: stderr when there is any, else
 *  stdout. A spill notice is cut to its first line, which carries the size
 *  and exit code; the rest is written for the model. */
export function commandDetail(stdout: unknown, stderr: unknown): string | null {
  const chosen = [stderr, stdout].find((out) => typeof out === "string" && out.trim() !== "");
  if (typeof chosen !== "string") return null;
  const trimmed = chosen.trimEnd();
  return trimmed.startsWith(SPILL_NOTICE_PREFIX) ? trimmed.split("\n")[0] : trimmed;
}

function plural(count: number, noun: string): string {
  return count === 1 ? `${count} ${noun.replace(/s$/, "")}` : `${count} ${noun}`;
}

function summarizeBytes(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const bytes = value.length;
  return bytes < KILOBYTE ? `${bytes} B` : `${(bytes / KILOBYTE).toFixed(1)} KB`;
}

function hasField(value: unknown, field: string): value is Record<string, unknown> {
  return isPlainObject(value) && field in value;
}

/** Grep returns match objects, or path strings when `filesOnly` was set. */
function summarizeGrep(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  if (value.every((item) => typeof item === "string")) return plural(value.length, "files");
  const files = value.filter((match) => hasField(match, "file")).map((match) => match.file);
  const distinct = files.filter((file, index) => files.indexOf(file) === index);
  return `${plural(value.length, "lines")} in ${plural(distinct.length, "files")}`;
}

/** grepSpill returns matches, or `{ pattern, matches }` groups when asked for several patterns. */
function summarizeGrepSpill(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const grouped = value.every((item) => hasField(item, "matches") && Array.isArray(item.matches));
  const lines = grouped
    ? value.reduce((sum: number, group) => sum + (group.matches as unknown[]).length, 0)
    : value.length;
  return plural(lines, "lines");
}

function countOf(value: unknown, field: string): number {
  return hasField(value, field) && Array.isArray(value[field]) ? value[field].length : 0;
}

function summarizeTypecheck(value: unknown): string | null {
  if (!isPlainObject(value)) return null;
  const errors = countOf(value, "errors");
  const warnings = countOf(value, "warnings");
  if (errors === 0 && warnings === 0) return "clean";
  const parts = [
    errors > 0 ? plural(errors, "errors") : null,
    warnings > 0 ? plural(warnings, "warnings") : null,
  ];
  return parts.filter((part) => part !== null).join(", ");
}

function testCases(value: unknown): Record<string, unknown>[] {
  return hasField(value, "cases") && Array.isArray(value.cases)
    ? value.cases.filter((item) => isPlainObject(item))
    : [];
}

function summarizeTestReport(value: unknown): string | null {
  const cases = testCases(value);
  if (cases.length === 0) return null;
  const failed = cases.filter((item) => item.pass !== true).length;
  const passed = `${cases.length - failed} passed`;
  return failed === 0 ? passed : `${passed}, ${failed} failed`;
}

function summarizeEditCount(_value: unknown, args: ToolArgs): string | null {
  return Array.isArray(args.edits) ? plural(args.edits.length, "edits") : null;
}

/** A safeBash failure is `{command, exitCode, stderr, stdout}` as JSON. */
function safeBashFailure(message: string): { line: string | null; detail: string | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    // Not the JSON shape: an interrupt rejection or a refusal, printed as is.
    return null;
  }
  if (!hasField(parsed, "exitCode") || typeof parsed.exitCode !== "number") return null;
  return { line: `exit ${parsed.exitCode}`, detail: commandDetail(parsed.stdout, parsed.stderr) };
}

const exitCode: ExitCodeSummary = { exitCode: true };
const typecheckReport: CustomSummary = {
  custom: summarizeTypecheck,
  failsWhen: (value) => countOf(value, "errors") > 0,
};
const testReport: CustomSummary = {
  custom: summarizeTestReport,
  failsWhen: (value) => testCases(value).some((item) => item.pass !== true),
};
const bytesOfResult: CustomSummary = { custom: summarizeBytes };
const bytesOfContent: CustomSummary = { custom: (_value, args) => summarizeBytes(args.content) };

function summary(
  label: string,
  show: ShowParts,
  twoLines: boolean,
  result: ResultSummary = "none",
  failure?: FailureSummary,
): SummaryPresentation {
  return { kind: "summary", label, show, twoLines, result, failure };
}
/** One line when the call settles. */
const one = (label: string, show: ShowParts, result?: ResultSummary) =>
  summary(label, show, false, result);
/** A start line and an end line, for a call that can take long. */
const two = (label: string, show: ShowParts, result?: ResultSummary) =>
  summary(label, show, true, result);
const nothing: ShowParts = () => [];
const number: ShowParts = (a) => [prefixed("#", a.number)];
const silent: SilentPresentation = { kind: "silent" };

// A custom presentation owns both lifecycle phases, including empty starts.
// Keyed by the name the model sees, after any `.rename()`. A tool with no
// row gets the generic display: every argument at start, a preview at end.
// See docs/dev/agents/tool-output.md for the rules behind each row.
const TOOL_PRESENTATIONS: Record<string, ToolPresentation> = {
  todoWrite: { kind: "tasks", heading: { text: "✓ Tasks updated", style: "success" } },
  todoAdd: { kind: "tasks", heading: { text: "✓ Tasks updated", style: "success" } },
  todoUpdate: { kind: "tasks", heading: { text: "✓ Tasks updated", style: "success" } },
  todoList: { kind: "tasks", heading: { text: "Tasks", style: "heading" } },
  researchAgent: { kind: "agent", label: "Research" },
  codeAgent: { kind: "agent", label: "Code" },
  rewriteAgent: { kind: "agent", label: "Rewrite" },
  writingAgent: { kind: "agent", label: "Writing review" },
  reviewAgent: { kind: "agent", label: "Review" },
  oracleAgent: { kind: "agent", label: "Oracle" },
  explorerAgent: { kind: "agent", label: "Explorer" },

  // Files
  read: one("Read", (a) => [filePath(a), lineRange(a)]),
  ls: one("List", (a) => [text(a.dir), flag(a, "recursive", "recursive")], { count: "entries" }),
  glob: one("Glob", (a) => [text(a.pattern), prefixed("in ", a.dir)], { count: "files" }),
  grep: one(
    "Grep",
    (a) => [
      text(a.pattern),
      prefixed("in ", a.path),
      flag(a, "filesOnly", "files only"),
      flag(a, "invert", "inverted"),
    ],
    { custom: summarizeGrep },
  ),
  write: one("Write", (a) => [filePath(a), a.mode === "append" ? "append" : null], bytesOfContent),
  edit: one("Edit", (a) => [filePath(a)], { custom: summarizeEditCount }),

  // Shell
  safeBash: summary("Run", (a) => [text(a.command)], true, "none", safeBashFailure),
  exec: two("Run", (a) => [text(a.command), text(a.args)], exitCode),
  readSpill: one("Read", (a, lookup) => [spillOutput(a.filename, lookup), lineRange(a)]),
  grepSpill: one(
    "Grep",
    (a, lookup) => [text(a.pattern), prefixed("in ", spillOutput(a.filename, lookup))],
    { custom: summarizeGrepSpill },
  ),

  // Git, read-only: local and fast, so one line
  gitIsRepo: one("git rev-parse", nothing),
  gitStatus: one("git status", nothing),
  gitLog: one("git log", (a) => [text(a.path), text(a.ref)]),
  gitDiff: one("git diff", (a) => [
    text(a.ref),
    text(a.ref2),
    text(a.path),
    flag(a, "staged", "--staged"),
  ]),
  gitShow: one("git show", (a) => [text(a.ref)]),
  gitBlame: one("git blame", (a) => [text(a.path)]),
  gitBranchList: one("git branch", nothing),
  gitRemoteList: one("git remote", nothing),
  gitStashList: one("git stash list", nothing),

  // Git, writes: the noun prints before the call runs
  gitAdd: two("git add", (a) => [text(a.paths), flag(a, "all", "--all")]),
  gitCommit: two("git commit", (a) => [text(a.message)]),
  gitCheckout: two("git checkout", (a) => [text(a.target), flag(a, "force", "--force")]),
  gitSwitch: two("git switch", (a) => [text(a.branch)]),
  gitBranchCreate: two("git branch", (a) => [text(a.branch)]),
  gitBranchDelete: two("git branch -d", (a) => [text(a.branch), flag(a, "force", "--force")]),
  gitStashPush: two("git stash push", nothing),
  gitStashPop: two("git stash pop", nothing),
  gitRestore: two("git restore", (a) => [text(a.paths)]),

  // GitHub: network calls, so two lines
  ghPrGet: two("gh pr get", number),
  ghPrList: two("gh pr list", nothing),
  ghPrDiff: two("gh pr diff", number),
  ghPrFiles: two("gh pr files", number),
  ghPrReviews: two("gh pr reviews", number),
  ghPrReviewComments: two("gh pr review comments", number),
  ghPrChecks: two("gh pr checks", number),
  ghIssueGet: two("gh issue get", number),
  ghIssueList: two("gh issue list", nothing),
  ghIssueComments: two("gh issue comments", number),
  ghIssueSearch: two("gh issue search", (a) => [text(a.query)]),
  ghPrReviewComment: two("gh pr comment", number),
  ghPrReview: two("gh pr review", (a) => [prefixed("#", a.number), text(a.event)]),
  ghPrApprove: two("gh pr approve", number),
  ghIssueCreate: two("gh issue create", (a) => [text(a.title)]),
  ghIssueComment: two("gh issue comment", number),
  ghIssueClose: two("gh issue close", number),
  ghIssueLabel: two("gh issue label", (a) => [prefixed("#", a.number), text(a.labels)]),

  // Web. The runtime folds the `url` alias into `baseUrl` before any hook.
  fetchMarkdown: two("Fetch", (a) => [urlWithPath(a)], bytesOfResult),
  wikipedia_search: two("Wikipedia", (a) => [text(a.query)]),
  wikipedia_summary: two("Wikipedia", (a) => [text(a.title)]),
  wikipedia_article: two("Wikipedia", (a) => [text(a.title)]),

  // Agency
  typecheck: one("Typecheck", nothing, typecheckReport),
  parseAST: one("Parse", nothing, "verdict"),
  testFile: two("Test", (a) => [text(a.filename)], testReport),
  agencyCli: two("agency", (a) => [text(a.args)], exitCode),

  // Docs and skills: `read` partially applied to a directory
  agencyGuide: one("Docs", (a) => [text(a.filename)]),
  agencyCliDocs: one("Docs", (a) => [text(a.filename)]),
  agencyDiagnostics: one("Docs", (a) => [text(a.filename)]),
  agencyStdlib: one("Docs", (a) => [text(a.filename)]),
  agencyAgent: one("Docs", (a) => [text(a.filename)]),
  skill: one("Skill", (a) => [text(a.name)]),
  coordinator_skills: one("Skill", (a) => [text(a.filename)]),
  skills_coding: one("Skill", (a) => [text(a.filename)]),
  superpowersSkill: one("Skill", (a) => [text(a.filename)]),

  // Memory: remember makes a model call
  remember: two("Remember", nothing),
  recall: one("Recall", (a) => [text(a.query)]),

  // Nothing to show: the interrupt prompt or the tool's own print is the display
  saveDraft: silent,
  question: silent,
  whatIAmDoing: silent,

  // Images
  generateImageFile: two("Generate image", (a) => [prefixed("→ ", a.path)]),
  viewImageFile: one("View", (a) => [text(a.path)]),

  // Coordinator
  learnSkill: two("Learn skill", (a) => [text(a.name)]),
  writeToolFor: two("Write tool", (a) => [text(a.name)]),
  learnTools: two("Learn tools", (a) => [
    hasField(a.source, "module") ? text(a.source.module) : null,
    hasField(a.source, "filename") ? text(a.source.filename) : null,
  ]),
  listPresets: one("Preset list", nothing),
  savePreset: one("Preset save", (a) => [text(a.name)]),
  deletePreset: one("Preset delete", (a) => [text(a.name)]),
  setDefaultPreset: one("Preset default", (a) => [text(a.name)]),
  useLlmOptions: one("LLM options", nothing),
  elapsedTime: one("Elapsed", nothing, "preview"),

  // Code agent
  setAgentCwd: one("Working directory", (a) => [prefixed("→ ", a.dir)]),
  getAgentCwd: one("Working directory", nothing, "preview"),
};

/** The tools with a row, for the test that checks every agent tool has one. */
export function presentedToolNames(): string[] {
  return Object.keys(TOOL_PRESENTATIONS);
}
const SEARCH_HEADINGS: Record<SearchPhase, TraceSpan> = {
  started: { text: "⌕ Web search", style: "active" },
  completed: { text: "✓ Web search", style: "success" },
  reported: { text: "⌕ Web search", style: "muted" },
  failed: { text: "✗ Web search", style: "error" },
};
type TodoStatus = "pending" | "in_progress" | "completed";
type Todo = { id: string; text: string; status: TodoStatus };
type TodoPresentation = { marker: TraceSpan; style?: TraceStyle; suffix: string };
const TODO_STATUSES: Record<TodoStatus, TodoPresentation> = {
  pending: { marker: { text: "○", style: "muted" }, suffix: "" },
  in_progress: {
    marker: { text: "›", style: "active" },
    style: "active",
    suffix: " · in progress",
  },
  completed: { marker: { text: "✓", style: "success" }, style: "completed", suffix: "" },
};

function columnsOrDefault(columns: number | undefined): number {
  return columns !== undefined && Number.isFinite(columns) && columns >= 1
    ? Math.floor(columns)
    : DEFAULT_COLUMNS;
}

export function traceOptionsForHost(host: Host, toolNames: boolean = false): TraceOptions {
  return {
    columns: columnsOrDefault(host.terminal.size()?.columns),
    color: host.terminal.supportsColor(),
    toolNames,
    spillSource: (name) => findOutputSource(currentRun(), name),
  };
}

/** Describe an event first; only the renderer knows about terminal layout. */
export function formatAgentTrace(event: AgentTraceEvent, options: TraceOptions): string {
  const block = describeEvent(event, options);
  return block === null ? "" : renderBlock(block, options);
}

/** One write keeps concurrent tool blocks together. */
export function printAgentTrace(
  host: Host,
  event: AgentTraceEvent,
  toolNames: boolean = false,
): void {
  const rendered = formatAgentTrace(event, traceOptionsForHost(host, toolNames));
  if (rendered !== "") {
    host.terminal.print([rendered + "\n"]);
  }
}

/** The Agency bridge. `toolNames` is the agent's debug flag. */
export function _printAgentTrace(event: AgentTraceEvent, toolNames: boolean = false): void {
  const host = currentHost();
  printAgentTrace(host, event, toolNames);
}

function describeEvent(event: AgentTraceEvent, options: TraceOptions): TraceBlock | null {
  switch (event.kind) {
    case "toolStart":
    case "toolEnd":
      return describeToolEvent(event, options);
    case "hostedSearch":
      return describeHostedSearch(event.result);
    case "agentStart": {
      const presentation = presentationFor(event.toolName);
      const label = presentation?.kind === "agent" ? presentation.label : "Agent";
      return {
        heading: toolHeading({ text: `→ ${label}`, style: "active" }, event.toolName),
        rows: [{ spans: [{ text: event.message, limit: RESULT_PREVIEW_LENGTH }] }],
      };
    }
    case "sessionSaveFailure":
      return {
        heading: [{ text: "! Session not saved", style: "warning", bold: true }],
        rows: [{ spans: [{ text: event.message }] }],
      };
  }
}

function presentationFor(toolName: string): ToolPresentation | undefined {
  return Object.hasOwn(TOOL_PRESENTATIONS, toolName) ? TOOL_PRESENTATIONS[toolName] : undefined;
}

function describeToolEvent(event: ToolEvent, options: TraceOptions): TraceBlock | null {
  if (event.provider) {
    return describeClientSearch(event, event.provider);
  }
  const presentation = presentationFor(event.toolName);
  if (presentation === undefined) {
    return event.kind === "toolStart" ? describeToolStart(event) : describeToolEnd(event);
  }
  if (presentation.kind === "silent") {
    return null;
  }
  if (presentation.kind === "summary") {
    return describeSummary(event, presentation, options);
  }
  if (event.kind === "toolStart") {
    return null;
  }
  if (presentation.kind === "tasks") {
    if (event.outcome === "failure") {
      return describeToolEnd(event, { text: "✗ Tasks failed", style: "error" });
    }
    return isTodoList(event.value)
      ? describeTodos(event.toolName, event.value, presentation.heading)
      : describeToolEnd(event, { text: "· Task result", style: "muted" });
  }
  const elapsed = elapsedText(event.timeTaken);
  const finished = elapsed === null ? "finished" : `finished · ${elapsed}`;
  const label =
    event.outcome === "failure"
      ? { text: `✗ ${presentation.label} failed`, style: "error" as const }
      : { text: `✓ ${presentation.label} ${finished}`, style: "success" as const };
  return describeToolEnd(event, label);
}

/** How long a call took, from one second; null below that. */
function elapsedText(timeTaken: number | undefined): string | null {
  return timeTaken !== undefined && timeTaken >= ELAPSED_FROM_MS ? formatElapsed(timeTaken) : null;
}

type Settled = { mark: TraceSpan; summary: string | null; detail: string | null };

/** What the end of a summary call says, from its outcome and result. */
function settle(event: ToolEndEvent, presentation: SummaryPresentation, args: ToolArgs): Settled {
  const success: TraceSpan = { text: "✓", style: "success" };
  const failed: TraceSpan = { text: "✗", style: "error" };
  if (event.outcome === "failure") {
    const message = typeof event.value === "string" ? event.value : serialize(event.value);
    const parsed = presentation.failure?.(message) ?? null;
    return parsed === null
      ? { mark: failed, summary: null, detail: message }
      : { mark: failed, summary: parsed.line, detail: parsed.detail };
  }
  const result = presentation.result;
  if (result === "none" || result === "verdict") {
    return { mark: success, summary: null, detail: null };
  }
  if (result === "preview") {
    const preview = typeof event.value === "string" ? event.value : serialize(event.value);
    return { mark: success, summary: null, detail: preview === "" ? null : preview };
  }
  if ("count" in result) {
    const count = Array.isArray(event.value) ? plural(event.value.length, result.count) : null;
    return { mark: success, summary: count, detail: null };
  }
  if ("exitCode" in result) {
    const value = event.value;
    const code =
      hasField(value, "exitCode") && typeof value.exitCode === "number" ? value.exitCode : null;
    if (code === null) return { mark: success, summary: null, detail: null };
    const stdout = hasField(value, "stdout") ? value.stdout : null;
    const stderr = hasField(value, "stderr") ? value.stderr : null;
    return {
      mark: code === 0 ? success : failed,
      summary: `exit ${code}`,
      detail: code === 0 ? null : commandDetail(stdout, stderr),
    };
  }
  const fails = result.failsWhen?.(event.value) ?? false;
  return {
    mark: fails ? failed : success,
    summary: result.custom(event.value, args),
    detail: result.detail?.(event.value) ?? null,
  };
}

function describeSummary(
  event: ToolEvent,
  presentation: SummaryPresentation,
  options: TraceOptions,
): TraceBlock | null {
  const args: ToolArgs = isPlainObject(event.args) ? event.args : {};
  const lookup = options.spillSource ?? (() => null);
  const parts = presentation.show(args, lookup).filter((part) => part !== null);
  const name: TraceSpan[] = options.toolNames
    ? [{ text: "  " }, { text: event.toolName, style: "muted" }]
    : [];
  if (event.kind === "toolStart") {
    if (!presentation.twoLines) return null;
    return {
      heading: [
        { text: `● ${presentation.label}`, style: "active", bold: true },
        ...parts.map((part) => ({ text: ` ${part}` })),
        ...name,
      ],
      rows: [],
    };
  }
  const settled = settle(event, presentation, args);
  const elapsed = presentation.twoLines ? elapsedText(event.timeTaken) : null;
  const tail = [settled.summary, elapsed].filter((piece) => piece !== null);
  const detailStyle: TraceStyle = settled.mark.style === "error" ? "error" : "muted";
  return {
    heading: [
      { text: `${settled.mark.text} ${presentation.label}`, style: settled.mark.style, bold: true },
      ...parts.map((part) => ({ text: ` ${part}` })),
      ...tail.map((piece) => ({ text: ` · ${piece}`, style: "muted" as const })),
      ...name,
    ],
    rows:
      settled.detail === null ? [] : [{ spans: [{ text: settled.detail, style: detailStyle }] }],
  };
}

function isTodoList(value: unknown): value is Todo[] {
  return (
    Array.isArray(value) &&
    Array.from(value).every(
      (todo) =>
        isPlainObject(todo) &&
        typeof todo.id === "string" &&
        typeof todo.text === "string" &&
        typeof todo.status === "string" &&
        Object.hasOwn(TODO_STATUSES, todo.status),
    )
  );
}

function describeTodos(toolName: string, todos: Todo[], heading: TraceSpan): TraceBlock {
  const complete = todos.filter((todo) => todo.status === "completed").length;
  const rows: TraceRow[] = todos.map((todo) => {
    const presentation = TODO_STATUSES[todo.status];
    return {
      marker: presentation.marker,
      spans: [
        { text: todo.text, style: presentation.style },
        { text: presentation.suffix, style: "muted" },
      ],
    };
  });
  const taskRows = todos.length === 0 ? [{ spans: [{ text: "No tasks" }] }] : rows;
  return {
    heading: toolHeading(heading, toolName),
    rows: [
      { spans: [{ text: `${complete}/${todos.length} complete`, style: "muted" }] },
      ...taskRows,
    ],
  };
}

function describeHostedSearch(result: unknown): TraceBlock | null {
  if (!isPlainObject(result) || result.tool !== "web_search") {
    return null;
  }
  const provider =
    typeof result.provider === "string" && result.provider !== ""
      ? result.provider
      : "Provider not reported";
  const queries: string[] = Array.isArray(result.queries)
    ? result.queries.filter(
        (query): query is string => typeof query === "string" && query.trim().length > 0,
      )
    : [];
  return describeSearch({
    toolName: "web_search",
    provider,
    phase: "reported",
    queries,
    sources: result.sources === undefined ? undefined : readSources(result.sources),
  });
}

function describeClientSearch(event: ToolEvent, provider: string): TraceBlock {
  if (event.kind === "toolStart") {
    const query = isPlainObject(event.args) ? event.args.query : undefined;
    return describeSearch({
      toolName: event.toolName,
      provider,
      phase: "started",
      queries: typeof query === "string" && query.trim() !== "" ? [query] : [],
    });
  }
  if (event.outcome === "failure") {
    return describeSearch({
      toolName: event.toolName,
      provider,
      phase: "failed",
      error: typeof event.value === "string" ? event.value : serialize(event.value),
    });
  }
  return describeSearch({
    toolName: event.toolName,
    provider,
    phase: "completed",
    sources: readSources(event.value),
  });
}

function readSources(value: unknown): SearchSource[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const sources = value.filter(
    (source): source is SearchSource =>
      isPlainObject(source) &&
      typeof source.url === "string" &&
      source.url.trim() !== "" &&
      (source.title === undefined || typeof source.title === "string"),
  );
  return value.length > 0 && sources.length === 0 ? null : sources;
}

function describeSources(sources: SearchSource[] | null): TraceRow[] {
  if (sources === null) {
    return [{ spans: [{ text: "Sources not reported", style: "muted" }] }];
  }
  const count = sources.length === 1 ? "1 source" : `${sources.length} sources`;
  const rows: TraceRow[] = sources.slice(0, SOURCE_PREVIEW_COUNT).flatMap((source, index) => {
    const title = source.title?.trim() ? source.title : source.url;
    const titleRow: TraceRow = {
      marker: { text: `${index + 1}.`, style: "muted" },
      spans: [{ text: title }],
    };
    return title === source.url
      ? [titleRow]
      : [
          titleRow,
          {
            marker: { text: "  " },
            spans: [{ text: source.url, style: "muted" }],
          },
        ];
  });
  const remaining = sources.length - SOURCE_PREVIEW_COUNT;
  const overflow: TraceRow[] =
    remaining > 0 ? [{ spans: [{ text: `… ${remaining} more sources`, style: "muted" }] }] : [];
  return [{ spans: [{ text: count, style: "muted" }] }, ...rows, ...overflow];
}

function describeSearch(search: SearchDescription): TraceBlock {
  const { queries, provider } = search;
  const count = queries?.length === 1 ? "1 query" : `${queries?.length ?? 0} queries`;
  const metadata = queries?.length ? `${provider} · ${count}` : provider;
  const queryRows: TraceRow[] =
    queries?.map((query) => ({
      marker: { text: "·", style: "muted" },
      spans: [{ text: query }],
    })) ?? [];
  const missingQueries: TraceRow[] =
    queries?.length === 0 ? [{ spans: [{ text: "Queries not reported", style: "muted" }] }] : [];
  const sourceRows = search.sources === undefined ? [] : describeSources(search.sources);
  const errorRows: TraceRow[] =
    search.error === undefined ? [] : [{ spans: [{ text: search.error, style: "error" }] }];
  return {
    heading: toolHeading(SEARCH_HEADINGS[search.phase], search.toolName),
    rows: [
      { spans: [{ text: metadata, style: "muted" }] },
      ...queryRows,
      ...missingQueries,
      ...sourceRows,
      ...errorRows,
    ],
  };
}

function toolHeading(label: TraceSpan, toolName: string): TraceSpan[] {
  return [{ ...label, bold: true }, { text: "  " }, { text: toolName, style: "muted" }];
}

function describeToolStart(event: ToolStartEvent): TraceBlock {
  const rows: TraceRow[] = isPlainObject(event.args)
    ? Object.entries(event.args).map(([key, value]) => ({
        spans: [
          { text: key + ": ", style: "muted" },
          { text: serialize(value), limit: ARGUMENT_PREVIEW_LENGTH },
        ],
      }))
    : [{ spans: [{ text: serialize(event.args), limit: ARGUMENT_PREVIEW_LENGTH }] }];
  return {
    heading: toolHeading({ text: "● Tool call", style: "active" }, event.toolName),
    rows,
  };
}

function describeToolEnd(
  event: ToolEndEvent,
  heading: TraceSpan = OUTCOMES[event.outcome],
): TraceBlock {
  const text = typeof event.value === "string" ? event.value : serialize(event.value);
  const empty = event.value === null || event.value === undefined || event.value === "";
  const span: TraceSpan =
    event.outcome === "failure"
      ? { text, style: "error" }
      : { text, style: "muted", limit: RESULT_PREVIEW_LENGTH };
  return {
    heading: toolHeading(heading, event.toolName),
    rows: empty ? [] : [{ spans: [span] }],
  };
}

function serialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "[unserializable value]";
  } catch {
    return "[unserializable value]";
  }
}

function sanitize(text: string): string {
  const normalized = stripAnsi(text).replace(/\r\n/g, "\n");
  return stripControlCharacters(normalized).replace(/\t/g, " ".repeat(TAB_WIDTH));
}

function renderSpan(span: TraceSpan, options: TraceOptions): string {
  const clean = sanitize(span.text);
  const characters = Array.from(clean);
  const text =
    span.limit !== undefined && characters.length > span.limit
      ? characters.slice(0, span.limit).join("") + "…"
      : clean;
  const palette = options.color ? color : plainColor;
  const styles = {
    heading: palette.bold,
    muted: palette.dim,
    completed: palette.dim.strikethrough,
    active: palette.blue,
    success: palette.green,
    error: palette.red,
    warning: palette.yellow,
  };
  const style = span.style === undefined ? palette : styles[span.style];
  return span.bold ? style.bold(text) : style(text);
}

function renderBlock(block: TraceBlock, options: TraceOptions): string {
  const heading = renderLines(block.heading, "", HEADING_CONTINUATION, options);
  const rows = block.rows.flatMap((row) => {
    const rail = renderSpan({ text: BODY_PREFIX, style: "muted" }, options);
    const marker = row.marker ? renderSpan(row.marker, options) + " " : "";
    return renderLines(row.spans, rail + marker, rail + " ".repeat(visualWidth(marker)), options);
  });
  return [...heading, ...rows].join("\n");
}

function renderLines(
  spans: TraceSpan[],
  firstPrefix: string,
  continuationPrefix: string,
  options: TraceOptions,
): string[] {
  const columns = columnsOrDefault(options.columns);
  const prefixWidth = Math.max(visualWidth(firstPrefix), visualWidth(continuationPrefix));
  // At tiny widths, spend the available space on content instead of decoration.
  const prefixesFit = prefixWidth < columns;
  const width = prefixesFit ? columns - prefixWidth : columns;
  const content = spans.map((span) => renderSpan(span, options)).join("");
  return wrapText(content, width).map((line, index) => {
    const linePrefix = index === 0 ? firstPrefix : continuationPrefix;
    const prefix = prefixesFit ? linePrefix : "";
    const rendered = prefix + line;
    return options.color && rendered.includes("\x1b") && !rendered.endsWith(RESET)
      ? rendered + RESET
      : rendered;
  });
}
