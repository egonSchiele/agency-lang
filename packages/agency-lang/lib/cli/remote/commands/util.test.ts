import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
// Spread the real fs so behavior is unchanged but the namespace is spyable — the
// single-read test spies on readFileSync.
vi.mock("fs", async (importOriginal) => ({ ...(await importOriginal<typeof import("fs")>()) }));
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AgencyConfig } from "@/config.js";
import {
  apiKeyOrExit,
  resolveApiKey,
  resolveAccountTarget,
  resolveProjectTarget,
  type RemoteCommandContext,
} from "./util.js";

class ProcessExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

let dir: string;
let configPath: string;
let errors: string[];
let exitSpy: ReturnType<typeof vi.spyOn>;

function context(config: AgencyConfig = {}): RemoteCommandContext {
  return { config, configPath };
}

function writeBinding(origin: string): void {
  fs.writeFileSync(
    configPath,
    JSON.stringify({ remote: { serveUrl: `${origin}/serve/user/proj/agent.agency` } }),
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-util-"));
  configPath = path.join(dir, "agency.json");
  process.env.STATELOG_API_KEY = "default-secret";
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.join(" "));
  });
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ProcessExit(code ?? 0);
  }) as never);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.STATELOG_API_KEY;
  delete process.env.MY_ACCOUNT_KEY;
  vi.restoreAllMocks();
});

describe("resolveAccountTarget", () => {
  it("selects a valid --host ahead of config and binding", () => {
    writeBinding("https://binding.example");
    const result = resolveAccountTarget(
      context({ log: { host: "https://config.example" } }),
      { host: "https://flag.example/" },
    );
    expect(result).toEqual({
      origin: "https://flag.example",
      apiKey: "default-secret",
      apiKeyEnvName: "STATELOG_API_KEY",
    });
  });

  it("rejects an invalid --host instead of falling through", () => {
    writeBinding("https://binding.example");
    expect(() =>
      resolveAccountTarget(context({ log: { host: "https://config.example" } }), {
        host: "not-a-url",
      }),
    ).toThrow(ProcessExit);
    expect(errors.join("\n")).toContain('Invalid statelog host "not-a-url"');
  });

  it("rejects invalid log.host instead of falling through to binding", () => {
    writeBinding("https://binding.example");
    expect(() =>
      resolveAccountTarget(context({ log: { host: "ftp://bad" } }), {}),
    ).toThrow(ProcessExit);
    expect(errors.join("\n")).toContain('Invalid statelog host "ftp://bad"');
  });

  it("uses the already-canonical binding origin when flag and config are absent", () => {
    writeBinding("https://binding.example");
    expect(resolveAccountTarget(context(), {}).origin).toBe("https://binding.example");
  });

  it("fails clearly when no host source is present", () => {
    expect(() => resolveAccountTarget(context(), {})).toThrow(ProcessExit);
    expect(errors.join("\n")).toContain("No statelog host");
  });
});

describe("resolveApiKey", () => {
  it("resolves a custom key name and value in one operation", () => {
    process.env.MY_ACCOUNT_KEY = "custom-secret";
    expect(resolveApiKey({ apiKeyEnv: "MY_ACCOUNT_KEY" })).toEqual({
      apiKey: "custom-secret",
      apiKeyEnvName: "MY_ACCOUNT_KEY",
    });
    expect(apiKeyOrExit({ apiKeyEnv: "MY_ACCOUNT_KEY" })).toBe("custom-secret");
  });

  it("names the selected missing variable", () => {
    expect(() => resolveApiKey({ apiKeyEnv: "MISSING_KEY" })).toThrow(ProcessExit);
    expect(errors.join("\n")).toContain("Missing API key — set $MISSING_KEY.");
  });
});

describe("resolveProjectTarget", () => {
  it("reads the binding exactly once", () => {
    writeBinding("https://h"); // origin https://h, slug "proj"
    const read = vi.spyOn(fs, "readFileSync");
    resolveProjectTarget(context(), {});
    expect(read.mock.calls.filter(([candidate]) => candidate === configPath)).toHaveLength(1);
  });

  it("uses the binding slug when the resolved origin equals the binding origin", () => {
    writeBinding("https://h");
    expect(resolveProjectTarget(context({ log: { host: "https://h" } }), {}).projectSlug).toBe("proj");
  });

  it("rejects a binding slug against a different resolved origin", () => {
    writeBinding("https://prod");
    expect(() => resolveProjectTarget(context({ log: { host: "https://staging" } }), {})).toThrow(
      ProcessExit,
    );
    expect(errors.join("\n")).toContain("--project");
  });

  it("accepts an explicit non-empty --project against any origin and rejects empty", () => {
    expect(
      resolveProjectTarget(context({ log: { host: "https://h" } }), { project: "foo" }).projectSlug,
    ).toBe("foo");
    expect(() => resolveProjectTarget(context({ log: { host: "https://h" } }), { project: "" })).toThrow(
      ProcessExit,
    );
  });

  it("fails with no binding and no --project", () => {
    expect(() => resolveProjectTarget(context({ log: { host: "https://h" } }), {})).toThrow(ProcessExit);
    expect(errors.join("\n")).toContain("Pass --project");
  });
});
