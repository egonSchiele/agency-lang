import { color } from "@/utils/termcolors.js";
import { readBinding, writeBinding } from "../binding.js";
import { parseServeBaseUrl } from "../../statelog/serveUrl.js";
import { renderLink } from "../render.js";
import { fail } from "./util.js";
import type { RemoteCommandContext } from "./util.js";

export function runLink(options: { url?: string }, context: RemoteCommandContext): void {
  if (options.url !== undefined) {
    const address = parseServeBaseUrl(options.url);
    if (!address) {
      fail(`Not a serve URL: ${options.url} (expected …/serve/:user/:project/:file).`);
    }
    writeBinding(context.configPath, address);
    console.log(`${color.green("Linked")} to ${color.bold(address.filename)}`);
    return;
  }
  const binding = readBinding(context.configPath);
  if (!binding) {
    console.log(color.dim("Not linked. Run 'agency remote deploy <file>' to link this directory."));
    return;
  }
  console.log(renderLink(binding));
}
