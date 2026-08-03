// Open a URL in the platform browser. Platform selection and process launch are
// injectable so `runOpen` stays free of them and tests never launch a browser.

import { spawn } from "node:child_process";

export type BrowserDeps = {
  platform?: NodeJS.Platform;
  launch?: (command: string, args: string[]) => void;
};

export async function openBrowser(url: string, deps: BrowserDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  // `start` is a cmd.exe builtin, not an executable — spawn it via cmd.exe with
  // the empty "" title arg (mirrors stdlib/oauth.ts).
  const [command, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd.exe", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const launch = deps.launch ?? defaultLaunch;
  launch(command as string, args as string[]);
}

function defaultLaunch(command: string, args: string[]): void {
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  // Best-effort: a failed launch shouldn't crash the CLI, but shouldn't be
  // silent either.
  child.on("error", (error) => {
    console.error(`Could not open a browser: ${error.message}`);
  });
  child.unref();
}
