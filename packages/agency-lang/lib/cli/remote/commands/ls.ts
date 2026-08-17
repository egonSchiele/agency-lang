import { color } from "@/utils/termcolors.js";
import { readBinding } from "../binding.js";
import { createServeClient } from "../../statelog/serveClient.js";
import { createProjectClient } from "../../statelog/projectClient.js";
import type { HostedAgentInfo } from "../../statelog/projectClient.js";
import { renderManifest, renderHostedFiles } from "../render.js";
import { fail, apiKeyOrExit } from "./util.js";
import type { RemoteCommandContext } from "./util.js";

/** `agency remote ls` — the callable endpoints (serve `/list`) and the files
 *  currently deployed (project `/agent`). The endpoints are the command's
 *  reason to exist, so a failure there is fatal; the file listing is
 *  best-effort because an older host may not have the route yet. */
export async function runLs(
  options: { apiKeyEnv?: string },
  context: RemoteCommandContext,
): Promise<void> {
  const binding = readBinding(context.configPath);
  if (!binding) {
    fail(
      "Not linked. Run 'agency remote deploy <file>' first (or 'agency remote link --url <serveBase>').",
    );
  }
  const apiKey = apiKeyOrExit(options);
  try {
    const manifest = await createServeClient(binding, apiKey).fetchManifest();
    console.log(renderManifest(manifest, binding));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const files = await tryFetchAgentInfo(binding.origin, binding.projectId, apiKey);
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
