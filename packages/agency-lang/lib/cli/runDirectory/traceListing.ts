import { evalRecordFor } from "@/runDirectory/evalRecord.js";
import type { Trace } from "@/runDirectory/traces.js";
import { traceInputText } from "@/runDirectory/traceText.js";

import { formatTextTable, oneLine } from "./table.js";

/** The traces a file holds, for an error that asks the user to pick one. */
export function describeTraces(traces: readonly Trace[], sourcePath: string): string {
  const rows = traces.map((trace) => {
    const record = evalRecordFor(trace, sourcePath);
    const input = traceInputText(trace, record);
    return [
      trace.traceId,
      record.agentName ?? "(unnamed)",
      `$${record.metrics.costUsdTotal.toFixed(4)}`,
      input === null ? "" : oneLine(input, 60),
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
