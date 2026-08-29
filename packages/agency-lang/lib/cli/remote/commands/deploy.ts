import path from "path";
import { color } from "@/utils/termcolors.js";
import type { AgencyConfig } from "@/config.js";
import { deploy } from "../../deploy/deploy.js";
import { renderOutcome } from "../../deploy/render.js";
import { countExportedEndpoints } from "../exportedEndpoints.js";
import type { ExportedEndpointCount } from "../exportedEndpoints.js";
import { confirmDeployWithoutExports } from "../confirmation.js";
import type { RemoteCommandContext } from "./util.js";

export type RemoteDeployOptions = {
  host?: string;
  project?: string;
  apiKeyEnv?: string;
  dryRun?: boolean;
};

/** What actually happened, for callers that gate follow-up work on a real
 *  upload (schedule add's deploy-if-missing). A deploy error never produces an
 *  outcome — that path exits the process. */
export type RunDeployOutcome = "deployed" | "aborted" | "preview";

export async function runDeploy(
  file: string,
  options: RemoteDeployOptions,
  context: RemoteCommandContext,
): Promise<RunDeployOutcome> {
  // Catch the common mistake — a forgotten `export` — before uploading. A
  // parse/compile error here is swallowed so deploy()'s own validation reports
  // it with a better message.
  const counts = tryCountExports(file, context.config);
  if (counts && counts.nodes === 0 && counts.functions === 0) {
    console.log(noExportsMessage(file, counts));
    if (!(await confirmDeployWithoutExports({ dryRun: options.dryRun }))) {
      console.log("Aborted.");
      return "aborted";
    }
  }

  const outcome = await deploy(file, context.config, options);
  renderOutcome(outcome);
  if (outcome.kind === "error") {
    process.exit(1);
  }
  return outcome.kind === "deployed" ? "deployed" : "preview";
}

/** The warning, plus a hint when the exports exist but live in imported files:
 *  only the entrypoint's exports are served, so name the files and show the
 *  re-export line that would fix it. */
function noExportsMessage(file: string, counts: ExportedEndpointCount): string {
  const entrypoint = path.basename(file);
  const lines = [
    color.yellow(
      "This agent exports no nodes or functions, so it would have no callable endpoints.",
    ),
    color.dim("Nodes and functions must be marked 'export' to be served."),
  ];
  if (counts.imported.length > 0) {
    lines.push(
      color.dim(
        `Only exports in the entry point (${entrypoint}) are served. ` +
          "These imported files have exports of their own; re-export them to serve them:",
      ),
    );
    for (const { file: name, names } of counts.imported) {
      lines.push(color.dim(`  export { ${names.join(", ")} } from "./${name}"`));
    }
  }
  return lines.join("\n");
}

function tryCountExports(file: string, config: AgencyConfig): ExportedEndpointCount | null {
  try {
    return countExportedEndpoints(file, config);
  } catch {
    return null;
  }
}
