import { readBinding } from "../binding.js";
import { createServeClient } from "../../statelog/serveClient.js";
import { renderManifest } from "../render.js";
import { fail, apiKeyOrExit } from "./util.js";
import type { RemoteCommandContext } from "./util.js";

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
}
