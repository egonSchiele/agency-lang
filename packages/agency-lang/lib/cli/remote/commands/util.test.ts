import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AgencyConfig } from "@/config.js";
const { whoami, fetchAgentInfo } = vi.hoisted(() => ({
  whoami: vi.fn(),
  fetchAgentInfo: vi.fn(),
}));
vi.mock("../../statelog/accountClient.js", () => ({
  createAccountClient: () => ({ whoami }),
}));
vi.mock("../../statelog/projectClient.js", () => ({
  createProjectClient: () => ({ fetchAgentInfo }),
}));

import {
  apiKeyOrExit,
  resolveApiKey,
  resolveAccountTarget,
  resolveProjectLocation,
  resolveProjectTarget,
  resolveServeTarget,
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

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-util-"));
  configPath = path.join(dir, "agency.json");
  process.env.STATELOG_API_KEY = "default-secret";
  errors = [];
  whoami.mockReset();
  fetchAgentInfo.mockReset();
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
  it("selects a valid --host ahead of config", () => {
    const result = resolveAccountTarget(context({ log: { host: "https://config.example" } }), {
      host: "https://flag.example/",
    });
    expect(result).toEqual({
      origin: "https://flag.example",
      apiKey: "default-secret",
      apiKeyEnvName: "STATELOG_API_KEY",
    });
  });

  it("rejects an invalid --host instead of falling through", () => {
    expect(() =>
      resolveAccountTarget(context({ log: { host: "https://config.example" } }), {
        host: "not-a-url",
      }),
    ).toThrow(ProcessExit);
    expect(errors.join("\n")).toContain('Invalid statelog host "not-a-url"');
  });

  it("rejects invalid log.host", () => {
    expect(() => resolveAccountTarget(context({ log: { host: "ftp://bad" } }), {})).toThrow(
      ProcessExit,
    );
    expect(errors.join("\n")).toContain('Invalid statelog host "ftp://bad"');
  });

  it("canonicalizes log.host", () => {
    expect(
      resolveAccountTarget(context({ log: { host: "https://config.example/" } }), {}).origin,
    ).toBe("https://config.example");
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
  it("uses log.projectId when --project is absent", () => {
    expect(
      resolveProjectTarget(context({ log: { host: "https://h", projectId: "proj" } }), {})
        .projectSlug,
    ).toBe("proj");
  });

  it("prefers --project over log.projectId and rejects an empty one", () => {
    const config: AgencyConfig = { log: { host: "https://h", projectId: "proj" } };
    expect(resolveProjectTarget(context(config), { project: "foo" }).projectSlug).toBe("foo");
    expect(() => resolveProjectTarget(context(config), { project: "" })).toThrow(ProcessExit);
  });

  it("fails with no log.projectId and no --project", () => {
    expect(() => resolveProjectTarget(context({ log: { host: "https://h" } }), {})).toThrow(
      ProcessExit,
    );
    expect(errors.join("\n")).toContain("Set log.projectId in agency.json, or pass --project");
  });

  it("resolveProjectLocation never reads the key", () => {
    delete process.env.STATELOG_API_KEY;
    expect(
      resolveProjectLocation(context({ log: { host: "https://h", projectId: "proj" } }), {}),
    ).toEqual({ origin: "https://h", projectSlug: "proj" });
  });

  // Key resolution runs LAST: with STATELOG_API_KEY unset AND a bad input, the
  // input error is what the user sees — no credential access before the input
  // is valid.
  describe("with the API key unset, a CLI-input error is reported before the missing key", () => {
    const expectInputError = (
      config: AgencyConfig,
      options: Parameters<typeof resolveProjectTarget>[1],
      expected: string,
    ): void => {
      delete process.env.STATELOG_API_KEY;
      expect(() => resolveProjectTarget(context(config), options)).toThrow(ProcessExit);
      expect(errors.join("\n")).toContain(expected);
      expect(errors.join("\n")).not.toContain("Missing API key");
    };

    it("an empty --project", () => {
      expectInputError(
        { log: { host: "https://h" } },
        { project: "" },
        "--project must not be empty.",
      );
    });

    it("no host source at all", () => {
      expectInputError({}, {}, "No statelog host");
    });

    it("no project source at all", () => {
      expectInputError({ log: { host: "https://h" } }, {}, "pass --project");
    });
  });
});

describe("resolveServeTarget", () => {
  const config: AgencyConfig = { log: { host: "https://h", projectId: "proj" } };

  it("derives the serve address from whoami and the deployed entry point", async () => {
    whoami.mockResolvedValue({ userId: "u" });
    fetchAgentInfo.mockResolvedValue({ entryPoint: "agent.agency", lastUploadAt: null, files: [] });
    const target = await resolveServeTarget(context(config), {});
    expect(target.address).toEqual({
      serveUrl: "https://h/serve/u/proj/agent",
      origin: "https://h",
      userId: "u",
      projectId: "proj",
      filename: "agent",
    });
    expect(target.apiKey).toBe("default-secret");
    expect(target.agent.entryPoint).toBe("agent.agency");
  });

  it("fails when nothing is deployed", async () => {
    whoami.mockResolvedValue({ userId: "u" });
    fetchAgentInfo.mockResolvedValue({ entryPoint: null, lastUploadAt: null, files: [] });
    await expect(resolveServeTarget(context(config), {})).rejects.toThrow(ProcessExit);
    expect(errors.join("\n")).toContain("Nothing is deployed to project proj");
  });

  it("reports a failed lookup and exits", async () => {
    whoami.mockRejectedValue(new Error("401 from whoami"));
    await expect(resolveServeTarget(context(config), {})).rejects.toThrow(ProcessExit);
    expect(errors.join("\n")).toContain("401 from whoami");
  });
});
