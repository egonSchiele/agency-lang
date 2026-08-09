import { color } from "@/utils/termcolors.js";
import type { AgencyConfig } from "@/config.js";
import { deploy } from "../../deploy/deploy.js";
import { renderOutcome } from "../../deploy/render.js";
import { serveBaseUrl } from "../../statelog/uploadClient.js";
import { parseServeBaseUrl } from "../../statelog/serveUrl.js";
import { writeBinding } from "../binding.js";
import { countExportedEndpoints } from "../exportedEndpoints.js";
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
    console.log(
      color.yellow("This agent exports no nodes or functions, so it would have no callable endpoints.") +
        "\n" +
        color.dim("Nodes and functions must be marked 'export' to be served."),
    );
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
  if (outcome.kind !== "deployed") {
    return "preview"; // a --dry-run preview never writes a binding
  }

  const base = serveBaseUrl(outcome.endpointUrls);
  const address = base ? parseServeBaseUrl(base) : null;
  if (!address) {
    console.log(color.yellow("Deployed, but could not derive a serve URL to link."));
    return "deployed";
  }
  writeBinding(context.configPath, address);
  console.log(`\n${color.green("Linked")} this directory to ${color.bold(address.filename)}.`);
  return "deployed";
}

function tryCountExports(
  file: string,
  config: AgencyConfig,
): { nodes: number; functions: number } | null {
  try {
    return countExportedEndpoints(file, config);
  } catch {
    return null;
  }
}
