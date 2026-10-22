// What a command prints about a stop: each reader is a pure function of
// the checkpoint the run drew and the stop's location, over the
// `Checkpoint` methods the terminal's panes read too (`listThreads`,
// `listBranches`, `listGuards`, `loopState`, `framesAlong`), so the two
// views cannot drift. Nothing here imports the program's compiled module.
import * as fs from "fs";
import * as path from "path";

import type { SourceMap } from "@/backends/sourceMap.js";
import { frameName, type Checkpoint } from "@/runtime/state/checkpointStore.js";
import { GlobalStore } from "@/runtime/state/globalStore.js";
import type { StateJSON } from "@/runtime/state/stateStack.js";
import { statementStepPath } from "@/runtime/promptRunner.js";
import type { StopLocation } from "@/runtime/waits.js";

export type FrameView = {
  index: number;
  name: string;
  moduleId: string;
  args: Record<string, unknown>;
  locals: Record<string, unknown>;
  /** Set on a tool loop's frame. */
  loop?: { round: number; removedTools: string[] };
};

/** The frames from the root down to the stopped one, innermost last. */
export function stackOf(checkpoint: Checkpoint, branchPath: string[]): FrameView[] {
  return checkpoint.framesAlong(branchPath).map((frame, index) => frameView(frame, index));
}

function frameView(frame: StateJSON, index: number): FrameView {
  const view: FrameView = {
    index,
    name: frameName(frame.scopeName),
    moduleId: frame.moduleId ?? "",
    args: frame.args ?? {},
    locals: frame.locals ?? {},
  };
  const loop = loopOf(frame);
  if (loop !== null) {
    view.loop = loop;
  }
  return view;
}

/** The tool loop's round and removed tools, from its frame's locals. */
function loopOf(frame: StateJSON): { round: number; removedTools: string[] } | null {
  if (frame.scopeName !== "runPrompt") {
    return null;
  }
  const locals = frame.locals as { toolCallRound?: number; removedTools?: unknown };
  if (locals.toolCallRound === undefined) {
    return null;
  }
  return {
    round: locals.toolCallRound + 1,
    removedTools: Array.isArray(locals.removedTools) ? (locals.removedTools as string[]) : [],
  };
}

export function frameAt(
  checkpoint: Checkpoint,
  branchPath: string[],
  index: number | undefined,
): FrameView | null {
  const frames = stackOf(checkpoint, branchPath);
  const at = index === undefined ? frames.length - 1 : index;
  return frames[at] ?? null;
}

export function usageOf(checkpoint: Checkpoint): { totalTokens: number; totalCost: number } {
  return GlobalStore.tokenStatsFromJSON(checkpoint.globals);
}

/** The `__sourceMap` a compiled module carries, read from the file as
 *  text so the CLI never loads the program's code. The map is a JSON
 *  object literal after `__sourceMap = `, on one line or many depending
 *  on the compile; it is found by its opening brace and read to the
 *  matching one. Null when the file is not there or has no map. */
export function readSourceMap(compiledPath: string): SourceMap | null {
  let text: string;
  try {
    text = fs.readFileSync(compiledPath, "utf8");
  } catch {
    return null;
  }
  const literal = objectLiteralAfter(text, "__sourceMap = ");
  if (literal === null) {
    return null;
  }
  try {
    return JSON.parse(literal) as SourceMap;
  } catch {
    return null;
  }
}

/** The balanced `{ … }` that follows `marker` in `text`, strings
 *  skipped, or null when there is none. */
export function objectLiteralAfter(text: string, marker: string): string | null {
  const start = text.indexOf(marker);
  if (start === -1) {
    return null;
  }
  const open = text.indexOf("{", start + marker.length);
  if (open === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  for (let at = open; at < text.length; at++) {
    const char = text[at]!;
    if (inString) {
      if (char === "\\") {
        at++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(open, at + 1);
      }
    }
  }
  return null;
}

/** A program's path as the person sees it: relative to `cwd` when it is
 *  under it. */
export function shownPath(program: string, cwd: string): string {
  const relative = path.relative(cwd, program);
  return relative.startsWith("..") || path.isAbsolute(relative) ? program : relative;
}

/** The source line of a location, from its module's map; undefined when
 *  the map has no entry for it. */
export function lineFor(map: SourceMap | null, location: StopLocation): number | undefined {
  const scopeMap = map?.[`${location.moduleId}:${location.scopeName}`];
  const entry = scopeMap?.[statementStepPath(location.stepPath)];
  // The line the map records is the one before the statement runs.
  return entry === undefined ? undefined : entry.line + 1;
}

/** Where a module's source may be on disk: under the current directory,
 *  or beside the compiled program. */
export function sourcePathFor(moduleId: string, cwd: string, compiledPath: string): string | null {
  const candidates = [
    path.resolve(cwd, moduleId),
    path.resolve(path.dirname(compiledPath), path.basename(moduleId)),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

export type SourceWindow = { path: string; first: number; lines: string[] };

/** `context` lines either side of `line` in the file, numbered from
 *  `first`. Null when the file cannot be read. */
export function sourceAround(filePath: string, line: number, context: number): SourceWindow | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const all = text.split("\n");
  const first = Math.max(1, line - context);
  const last = Math.min(all.length, line + context);
  return { path: filePath, first, lines: all.slice(first - 1, last) };
}
