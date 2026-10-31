export type ToolSummary = { text: string; details: string[] };
type Arguments = Record<string, unknown>;
export type ToolSummaryFormatter = (args: Arguments, toolName: string) => ToolSummary | null;

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

function fileReadSummary(args: Arguments, prefix: string): ToolSummary | null {
  const range = readRange(args);
  const target = fileTarget(args);
  if (target === null || range === null) {
    return null;
  }
  return { text: `${prefix}${target}${range}`, details: [] };
}

export function readSummary(args: Arguments): ToolSummary | null {
  return fileReadSummary(args, "");
}

export function readSpillSummary(args: Arguments): ToolSummary | null {
  return fileReadSummary(args, "saved output ");
}

export function docsSummary(args: Arguments, toolName: string): ToolSummary | null {
  return fileReadSummary(args, `${toolName}: `);
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

function searchSummary(args: Arguments, key: string, details: string[]): ToolSummary | null {
  const target = scope(args, key);
  if (typeof args.pattern !== "string" || target === null) {
    return null;
  }
  return {
    text: `${quote(args.pattern)} in ${target}`,
    details,
  };
}

export function grepSummary(args: Arguments): ToolSummary | null {
  const key = args.path !== undefined ? "path" : "dir";
  return searchSummary(args, key, grepModes(args));
}

export function globSummary(args: Arguments): ToolSummary | null {
  return searchSummary(args, "dir", []);
}

export function spillSearchSummary(args: Arguments): ToolSummary | null {
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

export function listingSummary(args: Arguments): ToolSummary | null {
  const target = scope(args, "dir");
  const details = args.recursive === true ? ["recursive"] : [];
  return target === null ? null : { text: target, details };
}

export function writeSummary(args: Arguments): ToolSummary | null {
  const target = fileTarget(args);
  if (target === null) {
    return null;
  }
  const mode = typeof args.mode === "string" ? ` · ${args.mode}` : "";
  return { text: target + mode, details: [] };
}

export function editSummary(args: Arguments): ToolSummary | null {
  const target = fileTarget(args);
  if (target === null || !Array.isArray(args.edits)) {
    return null;
  }
  const count = args.edits.length;
  return { text: `${target} · ${count} ${count === 1 ? "edit" : "edits"}`, details: [] };
}

function commandSummary(args: Arguments, command: unknown, words: unknown): ToolSummary | null {
  const cwd = scope(args, "cwd");
  if (typeof command !== "string" || cwd === null) {
    return null;
  }
  if (!Array.isArray(words) || !words.every((word) => typeof word === "string")) {
    return null;
  }
  const details = args.cwd === undefined || cwd === "" ? [] : [`in ${cwd}`];
  if (args.stdin !== undefined && args.stdin !== null && args.stdin !== "") {
    details.push("with stdin");
  }
  return { text: [command, ...words.map(quote)].join(" "), details };
}

export function shellSummary(args: Arguments): ToolSummary | null {
  return commandSummary(args, args.command, []);
}

export function execSummary(args: Arguments): ToolSummary | null {
  return commandSummary(args, args.command, args.args ?? []);
}

export function agencyCliSummary(args: Arguments): ToolSummary | null {
  return commandSummary(args, "agency", args.args ?? []);
}
