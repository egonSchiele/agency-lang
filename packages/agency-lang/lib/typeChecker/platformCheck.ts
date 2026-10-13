// The platform check: when a program is compiled for a platform that lacks
// a capability (`platform` in the config, `--platform` on the command
// line), every node and every exported function is checked against what it
// needs from the host: its own `@capabilities` tag and the tags of
// everything it calls. A violation is AG3029, with the calls from the node
// to the function whose tag carries the capability. The check changes
// nothing in the emitted code. See docs/dev/language/capabilities.md.

import path from "path";
import type { AgencyNode } from "../types.js";
import type { Capability } from "../host/host.js";
import { PLATFORM_CAPABILITIES } from "../host/host.js";
import { walkNodes } from "../utils/node.js";
import { getStdlibDir, stdlibModuleName } from "../importPaths.js";
import { diagnostic } from "./diagnostics.js";
import { ownCapabilities } from "./capabilitiesTag.js";
import type { ScopeInfo, TypeCheckError, TypeCheckerContext } from "./types.js";
import {
  qualifyName,
  type CallEdge,
  type CallGraphFunction,
  type InterruptCallGraph,
} from "./interruptAnalysis.js";

type CapabilityMap = Record<string, Capability[]>;

/** The diagnostic the platform setting turns on. The compile path treats
 *  it as fatal whether or not the type checker was asked for. */
export function isPlatformDiagnostic(error: TypeCheckError): boolean {
  return error.name === "platformLacksCapability";
}

export function checkPlatformCapabilities(
  scopes: ScopeInfo[],
  capabilitiesByFunction: CapabilityMap,
  callGraph: InterruptCallGraph,
  ctx: TypeCheckerContext,
): void {
  const platform = ctx.config.platform ?? "node";
  const available = PLATFORM_CAPABILITIES[platform];
  const own = ownCapabilities(ctx.programNodes);
  for (const info of scopes) {
    const kind = entryKind(info.name, ctx);
    if (kind === null) {
      continue;
    }
    for (const capability of capabilitiesByFunction[info.name] ?? []) {
      if (available.includes(capability)) {
        continue;
      }
      const loc = ctx.nodeDefs[info.name]?.loc ?? ctx.functionDefs[info.name]?.loc ?? null;
      ctx.errors.push(
        diagnostic(
          "platformLacksCapability",
          {
            kind,
            name: info.name,
            capability,
            platform,
            path: callPath(info, capability, scopes, capabilitiesByFunction, own, callGraph, ctx),
          },
          loc,
        ),
      );
    }
  }
}

/** "Node" for a node, "Function" for an exported function, null for a
 *  scope the check does not cover: a function the file keeps to itself
 *  is reached only through one it exports, and is reported there. */
function entryKind(name: string, ctx: TypeCheckerContext): "Node" | "Function" | null {
  if (ctx.nodeDefs[name] !== undefined) {
    return "Node";
  }
  if (ctx.functionDefs[name]?.exported === true) {
    return "Function";
  }
  return null;
}

/**
 * The calls from `start` to the function whose own tag carries
 * `capability`, one per line, found by following the call graph through
 * the file's own functions and stopping at the first imported one. A
 * function value the graph cannot follow (a function stored in a variable)
 * ends the path with a line that says so. Built only for a violation,
 * since it walks bodies for positions.
 */
function callPath(
  start: ScopeInfo,
  capability: Capability,
  scopes: ScopeInfo[],
  needs: CapabilityMap,
  own: CapabilityMap,
  callGraph: InterruptCallGraph,
  ctx: TypeCheckerContext,
): string {
  const lines: string[] = [];
  const visited: string[] = [];
  let current: ScopeInfo | undefined = start;
  while (current !== undefined && !visited.includes(current.name)) {
    visited.push(current.name);
    if ((own[current.name] ?? []).includes(capability)) {
      lines.push(`  ${current.name} is tagged ${capability} (${where(current.file, null)})`);
      return lines.join("\n");
    }
    const entry: CallGraphFunction | undefined = callGraph[qualifyName(current.file, current.name)];
    const callee: CallEdge | undefined = entry?.callEdges.find((edge: CallEdge) =>
      (needs[edge.calleeName] ?? []).includes(capability),
    );
    if (callee === undefined) {
      lines.push(`  ${current.name} needs ${capability} through a function value`);
      return lines.join("\n");
    }
    const call = callSite(current, callee.calleeName);
    const next: ScopeInfo | undefined = scopes.find(
      (info) => info.name === callee.calleeName && entryScope(info, ctx),
    );
    if (next === undefined) {
      const origin = ctx.importedFunctions[callee.calleeName]?.originFile;
      const from = origin === undefined ? "" : ` from ${moduleName(origin)}`;
      lines.push(
        `  ${current.name} calls ${callee.calleeName}${from} (${where(current.file, call)}), which needs ${capability}`,
      );
      return lines.join("\n");
    }
    lines.push(`  ${current.name} calls ${callee.calleeName} (${where(current.file, call)})`);
    current = next;
  }
  return lines.join("\n");
}

/** Whether a scope is a function or node of the file, not a nested block. */
function entryScope(info: ScopeInfo, ctx: TypeCheckerContext): boolean {
  return ctx.functionDefs[info.name] !== undefined || ctx.nodeDefs[info.name] !== undefined;
}

/** The first call of `name` in the body, or the first mention of it as a
 *  value (a tool handed to llm, a function passed along). */
function callSite(info: ScopeInfo, name: string): AgencyNode | null {
  let mention: AgencyNode | null = null;
  for (const { node } of walkNodes(info.body)) {
    if (node.type === "functionCall" && node.functionName === name) {
      return node;
    }
    if (mention === null && node.type === "variableName" && node.value === name) {
      mention = node;
    }
  }
  return mention;
}

/** `std::shell` for a stdlib file, the file's name for any other. */
function moduleName(file: string): string {
  if (file.startsWith(getStdlibDir() + path.sep)) {
    return stdlibModuleName(file);
  }
  return path.basename(file);
}

function where(file: string, node: AgencyNode | null): string {
  const name = file === "" ? "" : path.basename(file);
  if (node?.loc === undefined || node.loc === null) {
    return name;
  }
  return `${name}:${node.loc.line + 1}`;
}
