import { createServeClient } from "../../statelog/serveClient.js";
import { renderManifest, renderHostedFiles } from "../render.js";
import { fail, resolveServeTarget } from "./util.js";
import type { RemoteCommandContext } from "./util.js";

/** `agency remote ls` — the callable endpoints (serve `/list`) and the files
 *  currently deployed (project `/agent`, already fetched to resolve the
 *  target). */
export async function runLs(
  options: { host?: string; project?: string; apiKeyEnv?: string },
  context: RemoteCommandContext,
): Promise<void> {
  const target = await resolveServeTarget(context, options);
  const { address, apiKey } = target;
  try {
    const manifest = await createServeClient(address, apiKey).fetchManifest();
    console.log(renderManifest(manifest, address));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  console.log("");
  console.log(renderHostedFiles(target.agent));
}
