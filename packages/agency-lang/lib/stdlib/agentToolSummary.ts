import { isPlainObject } from "../config/paths.js";

export type ToolSummaryKind =
  | "read"
  | "readSpill"
  | "docs"
  | "grep"
  | "grepSpill"
  | "glob"
  | "ls"
  | "write"
  | "edit"
  | "shell"
  | "exec"
  | "agencyCli";
export type ToolSummary = { text: string; details: string[] };
type Arguments = Record<string, unknown>;

function quote(value: string): string {
  return JSON.stringify(value);
}

function scope(args: Arguments, key: string): string | null {
  const value = args[key];
  if (value === undefined) {
    return ".";
  }
  return typeof value === "string" ? value : null;
}

function fileTarget(args: Arguments): string | null {
  const dir = scope(args, "dir");
  if (typeof args.filename !== "string" || dir === null) {
    return null;
  }
  return dir === "." ? args.filename : `${dir.replace(/\/$/, "")}/${args.filename}`;
}

function readRange(args: Arguments): string | null {
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 0;
  if (
    typeof offset !== "number" ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 0
  ) {
    return null;
  }
  const first = Math.max(1, offset);
  if (limit > 0) {
    return ` · lines ${first}–${first + limit - 1}`;
  }
  return first > 1 ? ` · lines ${first}–end` : "";
}

function readSummary(kind: ToolSummaryKind, toolName: string, args: Arguments): ToolSummary | null {
  const range = readRange(args);
  const target = fileTarget(args);
  if (target === null || range === null) {
    return null;
  }
  const prefixes: Record<string, string> = { readSpill: "saved output ", docs: `${toolName}: ` };
  return { text: `${prefixes[kind] ?? ""}${target}${range}`, details: [] };
}

const SEARCH_MODES = [
  { key: "wholeWord", value: true, label: "whole words" },
  { key: "filesOnly", value: true, label: "files only" },
  { key: "invert", value: true, label: "nonmatching lines" },
  { key: "respectGitignore", value: false, label: "including ignored files" },
] as const;

function grepModes(args: Arguments): string[] {
  const flags = typeof args.flags === "string" ? args.flags : "";
  const modes = flags !== "" && flags !== "i" ? [`flags ${quote(flags)}`] : [];
  return [
    ...modes,
    ...SEARCH_MODES.filter((mode) => args[mode.key] === mode.value).map((mode) => mode.label),
  ];
}

function searchSummary(kind: ToolSummaryKind, args: Arguments): ToolSummary | null {
  const key = kind === "grep" && args.path !== undefined ? "path" : "dir";
  const target = scope(args, key);
  if (typeof args.pattern !== "string" || target === null) {
    return null;
  }
  return {
    text: `${quote(args.pattern)} in ${target}`,
    details: kind === "grep" ? grepModes(args) : [],
  };
}

function spillSearchSummary(args: Arguments): ToolSummary | null {
  if (typeof args.filename !== "string" || typeof args.pattern !== "string") {
    return null;
  }
  const more = args.morePatterns ?? [];
  if (!Array.isArray(more) || !more.every((pattern) => typeof pattern === "string")) {
    return null;
  }
  return {
    text: `${[args.pattern, ...more].map(quote).join(", ")} in saved output ${args.filename}`,
    details: [],
  };
}

function writeSummary(kind: ToolSummaryKind, args: Arguments): ToolSummary | null {
  const target = fileTarget(args);
  if (target === null) {
    return null;
  }
  if (kind === "edit") {
    if (!Array.isArray(args.edits)) {
      return null;
    }
    const count = args.edits.length;
    return { text: `${target} · ${count} ${count === 1 ? "edit" : "edits"}`, details: [] };
  }
  const mode = typeof args.mode === "string" ? ` · ${args.mode}` : "";
  return { text: target + mode, details: [] };
}

function commandSummary(kind: ToolSummaryKind, args: Arguments): ToolSummary | null {
  const command = kind === "agencyCli" ? "agency" : args.command;
  const cwd = scope(args, "cwd");
  if (typeof command !== "string" || cwd === null) {
    return null;
  }
  const words = kind === "shell" ? [] : (args.args ?? []);
  if (!Array.isArray(words) || !words.every((word) => typeof word === "string")) {
    return null;
  }
  const details = args.cwd === undefined || cwd === "" ? [] : [`in ${cwd}`];
  if (args.stdin !== undefined && args.stdin !== null && args.stdin !== "") {
    details.push("with stdin");
  }
  return { text: [command, ...words.map(quote)].join(" "), details };
}

/** Describes requested activity. Defaults and bound arguments are not in this event. */
export function summarizeToolCall(
  kind: ToolSummaryKind,
  toolName: string,
  args: unknown,
): ToolSummary | null {
  if (!isPlainObject(args)) {
    return null;
  }
  switch (kind) {
    case "read":
    case "readSpill":
    case "docs":
      return readSummary(kind, toolName, args);
    case "grep":
    case "glob":
      return searchSummary(kind, args);
    case "grepSpill":
      return spillSearchSummary(args);
    case "ls": {
      const target = scope(args, "dir");
      const recursive = args.recursive === true ? ["recursive"] : [];
      return target === null ? null : { text: target, details: recursive };
    }
    case "write":
    case "edit":
      return writeSummary(kind, args);
    case "shell":
    case "exec":
    case "agencyCli":
      return commandSummary(kind, args);
  }
}
