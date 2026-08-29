import { color } from "@/utils/termcolors.js";
import { createServeClient } from "../../statelog/serveClient.js";
import { createProjectClient } from "../../statelog/projectClient.js";
import type { HostedAgentInfo } from "../../statelog/projectClient.js";
import { renderManifest, renderHostedFiles } from "../render.js";
import { fail, resolveServeTarget } from "./util.js";
import type { RemoteCommandContext } from "./util.js";

/** `agency remote ls` — the callable endpoints (serve `/list`) and the files
 *  currently deployed (project `/agent`). The endpoints are the command's
 *  reason to exist, so a failure there is fatal; the file listing is
 *  best-effort because an older host may not have the route yet. */
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

  const files = await tryFetchAgentInfo(address.origin, address.projectId, apiKey);
  console.log("");
  if (files.ok) {
    console.log(renderHostedFiles(files.info));
  } else {
    console.log(color.dim(`Files: unavailable (${files.error})`));
  }
}

async function tryFetchAgentInfo(
  origin: string,
  projectSlug: string,
  apiKey: string,
): Promise<{ ok: true; info: HostedAgentInfo } | { ok: false; error: string }> {
  try {
    const info = await createProjectClient(origin, projectSlug, apiKey).fetchAgentInfo();
    return { ok: true, info };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
