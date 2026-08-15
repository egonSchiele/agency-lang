// Source discovery for the runs explorer: classify each CLI path as an
// eval run directory or a statelog file, and decide which screen a sole
// argument opens. Classification is cheap on purpose — a run dir is
// "has summary.json" (contents are a row problem, not a discovery
// problem) and a statelog is "first complete nonblank line is an
// enveloped JSON event". Nothing here reads more than one line.
import * as fs from "fs";
import * as path from "path";

export type Source =
  | { kind: "runDir"; dir: string }
  | { kind: "statelog"; file: string };

export type Discovery = {
  sources: Source[];
  /** Where a sole argument goes: one statelog file → today's viewer,
   *  one run dir → that run's per-test table, anything else → the
   *  explorer home table. */
  route: "viewer" | "runTable" | "explorer";
  errors: string[];
};

const SOURCE_SNIFF_CHUNK_BYTES = 64 * 1024;
const MAX_SOURCE_SNIFF_LINE_BYTES = 1024 * 1024;

const ACCEPTED_KINDS =
  "not a run directory (summary.json), a directory of run directories, or a statelog file";

export function discoverSources(paths: string[]): Discovery {
  const sources: Source[] = [];
  const errors: string[] = [];

  for (const rawPath of paths) {
    const resolved = path.resolve(rawPath);
    const stat = statOrNull(resolved);
    if (stat === null) {
      errors.push(`${rawPath}: no such file or directory — ${ACCEPTED_KINDS}`);
    } else if (stat.isFile()) {
      classifyFile(resolved, rawPath, sources, errors);
    } else {
      classifyDirectory(resolved, rawPath, sources, errors);
    }
  }

  return { sources, errors, route: routeFor(paths, sources) };
}

function routeFor(paths: string[], sources: Source[]): Discovery["route"] {
  const soleSource = paths.length === 1 && sources.length === 1;
  if (soleSource && sources[0].kind === "statelog") {
    return "viewer";
  }
  if (soleSource && sources[0].kind === "runDir") {
    return "runTable";
  }
  return "explorer";
}

function classifyFile(resolved: string, rawPath: string, sources: Source[], errors: string[]): void {
  const sniff = sniffFirstLine(resolved);
  if (sniff.kind === "line-too-long") {
    errors.push(`${rawPath}: first line exceeds ${MAX_SOURCE_SNIFF_LINE_BYTES} bytes — ${ACCEPTED_KINDS}`);
    return;
  }
  if (sniff.kind === "empty") {
    // An empty file is a statelog by fiat: the viewer owns empty-file
    // handling (it may be a log about to be written, under --follow).
    sources.push({ kind: "statelog", file: resolved });
    return;
  }
  if (isStatelogEnvelope(sniff.line)) {
    sources.push({ kind: "statelog", file: resolved });
    return;
  }
  errors.push(`${rawPath}: not statelog JSONL (first line is not an enveloped event) — ${ACCEPTED_KINDS}`);
}

function classifyDirectory(resolved: string, rawPath: string, sources: Source[], errors: string[]): void {
  if (fs.existsSync(path.join(resolved, "summary.json"))) {
    sources.push({ kind: "runDir", dir: resolved });
    return;
  }
  const childRuns = fs.readdirSync(resolved)
    .map((child) => path.join(resolved, child))
    .filter((child) => fs.existsSync(path.join(child, "summary.json")));
  if (childRuns.length === 0) {
    errors.push(`${rawPath}: directory contains no run directories — ${ACCEPTED_KINDS}`);
    return;
  }
  for (const dir of childRuns) {
    sources.push({ kind: "runDir", dir });
  }
}

type FirstLineSniff =
  | { kind: "line"; line: string }
  | { kind: "empty" }
  | { kind: "line-too-long" };

/** Read chunks until the first complete nonblank line arrives, without
 *  ever loading the file. A "complete" line ends in a newline or EOF. */
function sniffFirstLine(file: string): FirstLineSniff {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(SOURCE_SNIFF_CHUNK_BYTES);
    let carry = Buffer.alloc(0);
    for (;;) {
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, null);
      if (bytesRead === 0) {
        const finalLine = carry.toString("utf8").trim();
        if (finalLine === "") {
          return { kind: "empty" };
        }
        return { kind: "line", line: finalLine };
      }
      carry = Buffer.concat([carry, buf.subarray(0, bytesRead)]);
      let newlineAt: number;
      while ((newlineAt = carry.indexOf(0x0a)) !== -1) {
        const line = carry.subarray(0, newlineAt).toString("utf8").trim();
        carry = carry.subarray(newlineAt + 1);
        if (line !== "") {
          return { kind: "line", line };
        }
      }
      if (carry.length > MAX_SOURCE_SNIFF_LINE_BYTES) {
        return { kind: "line-too-long" };
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function isStatelogEnvelope(line: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return false;
  }
  const envelope = parsed as Record<string, unknown>;
  return "format_version" in envelope && "trace_id" in envelope;
}

function statOrNull(resolved: string): fs.Stats | null {
  try {
    return fs.statSync(resolved);
  } catch {
    return null;
  }
}
