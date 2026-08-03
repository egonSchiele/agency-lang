import { describe, it, expect } from "vitest";
import { openBrowser } from "./browser.js";

describe("openBrowser", () => {
  it("selects the platform opener and passes the url", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const launch = (cmd: string, args: string[]) => calls.push({ cmd, args });

    await openBrowser("http://x/y", { platform: "darwin", launch });
    await openBrowser("http://x/y", { platform: "linux", launch });
    await openBrowser("http://x/y", { platform: "win32", launch });

    expect(calls.map((call) => call.cmd)).toEqual(["open", "xdg-open", "start"]);
    expect(calls[0].args).toEqual(["http://x/y"]);
  });
});
