// One vertical slice with nothing replaced but the network: real runSecretsSet,
// real binding-based target resolution, real secretsClient, stubbed global
// fetch. Proves the layers agree on the wire contract AND on the no-output
// invariant: the sentinel value appears in the request body and nowhere else.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runSecretsSet } from "./secrets.js";
import type { RemoteCommandContext } from "./util.js";

const SENTINEL = "sk-live-EXTREMELY-SECRET";
const KEY_ENV = "SECRETS_VERTICAL_TEST_KEY";
const VALUE_ENV = "SECRETS_VERTICAL_VALUE";

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: "",
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

const metadata = {
  name: "OPENAI_API_KEY",
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
};

let dir: string;
let configPath: string;
let configBytes: string;
let fetchMock: ReturnType<typeof vi.fn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

function context(): RemoteCommandContext {
  return { config: {}, configPath } as RemoteCommandContext;
}

const io = {
  stdinIsTty: false,
  readStdin: () => Promise.reject(new Error("stdin must not be read when --from-env is given")),
  promptHidden: () => Promise.reject(new Error("prompt must not fire when --from-env is given")),
  env: process.env,
};

function allOutput(): string {
  return [...logSpy.mock.calls, ...errorSpy.mock.calls]
    .map((call: unknown[]) => call.join(" "))
    .join("\n");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-vertical-"));
  configPath = path.join(dir, "agency.json");
  configBytes = `${JSON.stringify(
    { remote: { serveUrl: "https://h/serve/u/proj/daily.agency" } },
    null,
    2,
  )}\n`;
  fs.writeFileSync(configPath, configBytes, "utf-8");
  process.env[KEY_ENV] = "vertical-api-key";
  process.env[VALUE_ENV] = SENTINEL;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new Error(`exit:${code}`);
  });
});

afterEach(() => {
  delete process.env[KEY_ENV];
  delete process.env[VALUE_ENV];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("runSecretsSet vertical contract", () => {
  it("POSTs the exact request; the value appears in the body and nowhere else", async () => {
    fetchMock.mockResolvedValue(response(200, { success: true, value: metadata }));

    const result = await runSecretsSet(
      "OPENAI_API_KEY",
      { project: "proj", apiKeyEnv: KEY_ENV, fromEnv: VALUE_ENV },
      context(),
      io,
    );

    expect(result).toEqual({ kind: "set" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://h/api/projects/proj/secrets");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: "Bearer vertical-api-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      name: "OPENAI_API_KEY",
      value: SENTINEL,
    });

    expect(logSpy.mock.calls[0]!.join(" ")).toContain("Set");
    expect(logSpy.mock.calls[1]!.join(" ")).toContain('env("OPENAI_API_KEY")');
    expect(allOutput()).not.toContain(SENTINEL);
    expect(fs.readFileSync(configPath, "utf-8")).toBe(configBytes);
  });

  it("a hostile HTTP-200 failure envelope surfaces redacted, with no success lines", async () => {
    fetchMock.mockResolvedValue(
      response(200, { success: false, error: `rejected, echoing ${SENTINEL}` }),
    );

    await expect(
      runSecretsSet(
        "OPENAI_API_KEY",
        { project: "proj", apiKeyEnv: KEY_ENV, fromEnv: VALUE_ENV },
        context(),
        io,
      ),
    ).rejects.toThrow("exit:1");

    expect(allOutput()).toContain("[redacted]");
    expect(allOutput()).not.toContain(SENTINEL);
    expect(logSpy).not.toHaveBeenCalled();
    expect(fs.readFileSync(configPath, "utf-8")).toBe(configBytes);
  });
});
