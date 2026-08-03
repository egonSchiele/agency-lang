// Open a URL in the platform browser. Platform selection and process launch are
// injectable so `runOpen` stays free of them and tests never launch a browser.

import { spawn } from "node:child_process";

export type BrowserDeps = {
  platform?: NodeJS.Platform;
  launch?: (command: string, args: string[]) => void;
};

export async function openBrowser(url: string, deps: BrowserDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const command =
    platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  const launch =
    deps.launch ??
    ((cmd, args) => {
      spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
    });
  launch(command, [url]);
}
