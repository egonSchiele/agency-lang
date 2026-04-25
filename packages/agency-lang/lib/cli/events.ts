import * as fs from "fs";
import { TraceReader } from "../runtime/trace/traceReader.js";
import { generateEventLog } from "../runtime/trace/eventLog.js";

export function traceLog(inputFile: string, outputFile?: string): void {
  const reader = TraceReader.fromFile(inputFile);
  const events = generateEventLog(reader.checkpoints);
  const json = JSON.stringify(events, null, 2);

  if (outputFile) {
    fs.writeFileSync(outputFile, json, "utf-8");
    console.log(
      `Event log written to ${outputFile} (${events.length} events)`,
    );
  } else {
    console.log(json);
  }
}
