/**
 * Writing the driver into a temp folder, running one of its nodes, and
 * deleting the folder again.
 */
import fs from "fs";
import path from "path";
import { applyCliFlags, type AgencyConfig } from "../../config/config.js";
import { makeAgencyTempDir } from "../../utils/agencyTempDir.js";
import { safeDeleteDirectoryWithin } from "../../utils.js";
import type { RootCarriers } from "../childEnv.js";
import { runAgencyNode } from "../util.js";
import { driverSource } from "./driver.js";
import type { ToolImport } from "./toolImports.js";

export type DriverCall = {
  /** The project directory. The temp folder goes in its `.agency-tmp`. */
  dir: string;
  imports: ToolImport[];
  node: string;
  args: unknown[];
  config: AgencyConfig;
  carriers?: RootCarriers;
};

export type DriverOutcome = { ok: true; data: unknown } | { ok: false; message: string };

export type NodeRunner = typeof runAgencyNode;

/** What went wrong in the child: its stderr when the error carries it. */
function messageOf(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  if (typeof stderr === "string" && stderr.trim() !== "") {
    return stderr.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

export async function runDriver(
  call: DriverCall,
  run: NodeRunner = runAgencyNode,
): Promise<DriverOutcome> {
  const folder = makeAgencyTempDir("workflow", call.dir);
  const agencyRoot = path.join(call.dir, ".agency-tmp");
  // compile() calls process.exit(1) on a compile error, which skips the
  // finally below. An exit listener still runs, but only synchronous work
  // does, and safeDeleteDirectoryWithin is synchronous.
  const cleanup = () => {
    safeDeleteDirectoryWithin(agencyRoot, folder);
  };
  process.once("exit", cleanup);
  try {
    const driverFile = path.join(folder, "driver.agency");
    fs.writeFileSync(driverFile, driverSource(call.imports, call.dir, folder));
    const result = await run({
      // The driver is never precompiled, so a project's distDir must not
      // send runAgencyNode looking for it.
      config: { ...applyCliFlags(call.config, { refuseSplices: true }), distDir: undefined },
      agencyFile: driverFile,
      nodeName: call.node,
      hasArgs: call.args.length > 0,
      argsString: call.args.map((arg) => JSON.stringify(arg)).join(", "),
      scratchDir: folder,
      quietCompile: true,
      rootCarriers: call.carriers,
    });
    return { ok: true, data: result.data };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  } finally {
    process.removeListener("exit", cleanup);
    cleanup();
  }
}
