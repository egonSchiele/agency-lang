import * as fs from "fs";
import * as path from "path";

/**
 * How an agent target string is parsed and resolved. A target names an agent
 * entry point: `path`, `path:node`, or a directory (meaning its main.agency).
 * Consumed by the eval commands, the optimizer, and `agency test`.
 */

export function parseTarget(target: string): {
  filename: string;
  nodeName: string;
} {
  const colonIndex = target.lastIndexOf(":");
  if (colonIndex === -1) {
    return { filename: target, nodeName: "" };
  }
  const filename = target.slice(0, colonIndex);
  const nodeName = target.slice(colonIndex + 1);
  return { filename, nodeName };
}

/** Resolve a target into the agent file, node (default "main"), and the
 *  display label run results carry. */
export function resolveEvalRunTarget(target: string): {
  agentFile: string;
  node: string;
  label: string;
} {
  const parsed = parseTarget(target);
  const resolved = path.resolve(parsed.filename);
  const agentFile =
    fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
      ? path.join(resolved, "main.agency")
      : resolved;
  const node = parsed.nodeName || "main";
  return { agentFile, node, label: `${agentFile}:${node}` };
}
