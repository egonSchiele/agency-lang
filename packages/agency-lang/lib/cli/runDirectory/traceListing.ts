import { extractEvalRecord } from "@/eval/extract.js";
import type { Trace } from "@/runDirectory/traces.js";

import { formatTextTable, oneLine } from "./table.js";

/** The traces a file holds, for an error that asks the user to pick one. */
export function describeTraces(traces: readonly Trace[], sourcePath: string): string {
  const rows = traces.map((trace) => {
    const record = extractEvalRecord(trace.events, sourcePath);
    const start = trace.events.find((event) => event.data.type === "agentStart");
    const input = start?.data.input ?? record.evalValues.at(-1)?.value;
    return [
      trace.traceId,
      record.agentName ?? "(unnamed)",
      `$${record.metrics.costUsdTotal.toFixed(4)}`,
      input === undefined || input === null
        ? ""
        : oneLine(typeof input === "string" ? input : JSON.stringify(input), 60),
    ];
  });
  return (
    "Available traces (pass a full id or any unique prefix to --trace):\n" +
    formatTextTable(["TRACE ID", "AGENT", "COST", "INPUT"], rows)
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n")
  );
}
