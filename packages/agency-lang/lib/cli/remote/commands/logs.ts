import { createProjectClient } from "../../statelog/projectClient.js";
import type { ProjectClient } from "../../statelog/projectClient.js";
import { normalizeTraceLogs, traceLogsToJsonl } from "../logsBridge.js";
import { openViewer } from "../../logsView.js";
import { renderTraceList } from "../render.js";
import { resolveProjectTarget, failProjectCommand, printJson } from "./util.js";
import type { ProjectCommandOptions, RemoteCommandContext } from "./util.js";
import type { RemoteLogsMode } from "./logsMode.js";

/** `agency remote logs` — list traces, or fetch one and open the viewer / print
 *  JSON. The mode is already resolved and TTY-validated by registration. */
export async function runLogs(
  mode: RemoteLogsMode,
  options: ProjectCommandOptions,
  context: RemoteCommandContext,
): Promise<void> {
  const target = resolveProjectTarget(context, options);
  const client = createProjectClient(target.origin, target.projectSlug, target.apiKey);
  try {
    if (mode.kind === "list") {
      const traces = await client.listTraces();
      if (mode.json) {
        printJson(traces);
      } else {
        console.log(renderTraceList(traces));
      }
      return;
    }

    const traceId = mode.traceId ?? (await latestTraceId(client));
    const logs = await client.traceLogs(traceId);
    if (mode.output === "json") {
      printJson(normalizeTraceLogs(logs));
      return;
    }
    await openViewer({ jsonl: traceLogsToJsonl(logs), terminalInput: "current-stdin" });
  } catch (error) {
    failProjectCommand(error);
  }
}

/** The most recent trace's id, or a clean failure (non-zero) when there are
 *  none — a fetch/open can't run without a trace. */
async function latestTraceId(client: ProjectClient): Promise<string> {
  const traces = await client.listTraces();
  const latest = traces[0];
  if (latest === undefined) {
    throw new Error("No traces yet — nothing to open. Run the deployed agent first.");
  }
  return latest.id;
}
