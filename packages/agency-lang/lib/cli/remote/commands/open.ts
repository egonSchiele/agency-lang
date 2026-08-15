import { color } from "@/utils/termcolors.js";
import { readBinding } from "../binding.js";
import { projectPageUrl } from "../../statelog/serveUrl.js";
import { openBrowser } from "../browser.js";
import { fail } from "./util.js";
import type { RemoteCommandContext } from "./util.js";

export async function runOpen(context: RemoteCommandContext): Promise<void> {
  const binding = readBinding(context.configPath);
  if (!binding) {
    fail(
      "Not linked. Run 'agency remote deploy <file>' first (or 'agency remote link --url <serveBase>').",
    );
  }
  const url = projectPageUrl(binding);
  console.log(color.dim(`Opening ${url}`));
  await openBrowser(url);
}
