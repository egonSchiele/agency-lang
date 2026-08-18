import { type Annotation } from "@/runDirectory/annotations.js";
import { recordNote } from "@/runDirectory/mutations.js";
import { readRunDirectory } from "@/runDirectory/runDir.js";
import { matchTrace } from "@/runDirectory/traces.js";

import { describeTraces } from "./traceListing.js";

export type NoteOptions = { dir: string; trace?: string; text: string; annotator?: string };

export type NoteDependencies = { report(message: string): void; user(): string };

const defaultDependencies: NoteDependencies = {
  report: (message) => console.log(message),
  user: () => process.env.USER ?? "unknown",
};

/** Append a free-text note about one trace. With one trace in the directory,
 *  `--trace` is optional. */
export function note(
  options: NoteOptions,
  dependencies: NoteDependencies = defaultDependencies,
): Annotation {
  const text = options.text.trim();
  if (text.length === 0) {
    throw new Error("A note needs some text.");
  }
  const traceId = resolveTraceId(options);
  const annotation = recordNote({
    dir: options.dir,
    traceId,
    annotator: { kind: "human", id: options.annotator ?? dependencies.user() },
    text,
  });
  dependencies.report(`Noted on trace ${traceId}: ${annotation.id}`);
  return annotation;
}

function resolveTraceId(options: NoteOptions): string {
  const snapshot = readRunDirectory(options.dir, {
    reportWarning: (message) => console.warn(message),
  });
  if (snapshot.traces.length === 0) {
    throw new Error(`${options.dir} holds no traces; add a statelog first.`);
  }
  if (options.trace === undefined) {
    if (snapshot.traces.length === 1) return snapshot.traces[0].traceId;
    throw new Error(
      `${options.dir} holds ${snapshot.traces.length} traces; say which with --trace <id>.\n` +
        describeTraces(snapshot.traces, options.dir),
    );
  }
  const match = matchTrace(snapshot.traces, options.trace);
  if (match.kind === "one") return match.trace.traceId;
  if (match.kind === "none") {
    throw new Error(
      `No trace in ${options.dir} matches "${options.trace}".\n${describeTraces(snapshot.traces, options.dir)}`,
    );
  }
  throw new Error(
    `Trace id "${options.trace}" is ambiguous: ${match.ids.join(", ")}. Use more characters.`,
  );
}
