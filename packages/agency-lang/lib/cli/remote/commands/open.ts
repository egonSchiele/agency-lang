import { color } from "@/utils/termcolors.js";
import { projectPageUrl } from "../../statelog/serveUrl.js";
import { openBrowser } from "../browser.js";
import { resolveProjectLocation } from "./util.js";
import type { RemoteCommandContext } from "./util.js";

/** `agency remote open` — the project page in a browser. No key needed. */
export async function runOpen(
  options: { host?: string; project?: string },
  context: RemoteCommandContext,
): Promise<void> {
  const location = resolveProjectLocation(context, options);
  const url = projectPageUrl({ origin: location.origin, projectId: location.projectSlug });
  console.log(color.dim(`Opening ${url}`));
  await openBrowser(url);
}
