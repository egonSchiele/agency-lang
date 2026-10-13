import { describe, it, expect } from "vitest";
import { browserHost } from "./browserHost.js";
import { PLATFORM_CAPABILITIES, UnsupportedOnHostError } from "./host.js";

describe("browserHost", () => {
  it("grants the browser capabilities and refuses the rest", () => {
    const host = browserHost();
    expect(host.name).toBe("browser");
    expect(host.capabilities).toEqual(PLATFORM_CAPABILITIES.browser);
    expect(() => host.files.root("/")).toThrow(UnsupportedOnHostError);
    expect(() => host.subprocess.run({ kind: "program", program: "ls", args: [] })).toThrow(
      UnsupportedOnHostError,
    );
  });

  it("answers env and settings from the variables the app gave", () => {
    const host = browserHost({ variables: { API_KEY: "k" } });
    expect(host.env.get("API_KEY")).toBe("k");
    expect(host.settings.read("API_KEY")).toBe("k");
    expect(host.env.get("MISSING")).toBeNull();
    host.env.set("NEW", "v");
    expect(host.env.all()).toEqual({ API_KEY: "k", NEW: "v" });
  });

  it("takes the terminal the app gave, and falls back to the console", async () => {
    const lines: string[] = [];
    const host = browserHost({ terminal: { print: (values) => lines.push(values.join(" ")) } });
    host.terminal.print(["hello", 1]);
    expect(lines).toEqual(["hello 1"]);
    await expect(host.terminal.readLine("> ")).rejects.toThrow(UnsupportedOnHostError);
    expect(host.terminal.size()).toBeNull();
    expect(host.terminal.supportsColor()).toBe(false);
  });

  it("reports the working directory it was given and refuses to exit", () => {
    const host = browserHost({ cwd: "/app" });
    expect(host.system.cwd()).toBe("/app");
    expect(host.system.moduleDir("https://example.test/dist/main.js")).toBe(
      "https://example.test/dist/",
    );
    expect(host.system.operatingSystem()).toBe("unknown");
    expect(() => host.system.exit(0)).toThrow("cannot end its process");
  });

  it("makes random ids and bytes from the page's crypto", () => {
    const host = browserHost();
    expect(host.random.id()).not.toBe(host.random.id());
    expect(host.random.bytes(8)).toHaveLength(8);
  });
});
