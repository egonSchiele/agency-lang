import { describe, it, expect } from "vitest";
import { openBrowser } from "./browser.js";

describe("openBrowser", () => {
  it("selects the platform opener with the full command and args", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const launch = (cmd: string, args: string[]) => calls.push({ cmd, args });

    await openBrowser("http://x/y", { platform: "darwin", launch });
    await openBrowser("http://x/y", { platform: "linux", launch });
    await openBrowser("http://x/y", { platform: "win32", launch });

    expect(calls[0]).toEqual({ cmd: "open", args: ["http://x/y"] });
    expect(calls[1]).toEqual({ cmd: "xdg-open", args: ["http://x/y"] });
    // `start` is a cmd.exe builtin — must be launched via cmd.exe, not spawned directly.
    expect(calls[2]).toEqual({ cmd: "cmd.exe", args: ["/c", "start", "", "http://x/y"] });
  });
});
