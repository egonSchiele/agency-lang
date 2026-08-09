import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  runSecretsSet,
  runSecretsList,
  runSecretsRm,
  presentSecretError,
} from "./secrets.js";
import { SecretRequestError } from "../../statelog/secretsClient.js";
import type { RemoteCommandContext } from "./util.js";
import { color } from "@/utils/termcolors.js";

const SENTINEL = "sk-live-EXTREMELY-SECRET";
const KEY_ENV = "SECRETS_RECIPE_TEST_KEY";

const setMock = vi.fn();
const listMock = vi.fn();
const deleteMock = vi.fn();
const clientFactoryMock = vi.fn((..._factoryArgs: unknown[]) => ({
  set: setMock,
  list: listMock,
  delete: deleteMock,
}));

vi.mock("../../statelog/secretsClient.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../statelog/secretsClient.js")>();
  return {
    ...original,
    createSecretsClient: (...factoryArgs: unknown[]) => clientFactoryMock(...factoryArgs),
  };
});

const context: RemoteCommandContext = {
  config: { log: { host: "https://h" } },
  configPath: "/nonexistent-secrets-recipe-test/agency.json",
} as RemoteCommandContext;

const options = { project: "proj", apiKeyEnv: KEY_ENV };

function io(overrides: Partial<Parameters<typeof runSecretsSet>[3]> = {}) {
  return {
    stdinIsTty: false,
    readStdin: vi.fn().mockResolvedValue(`${SENTINEL}\n`),
    promptHidden: vi.fn().mockResolvedValue(undefined),
    env: {} as NodeJS.ProcessEnv,
    ...overrides,
  };
}

const metadata = {
  name: "OPENAI_API_KEY",
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
};

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

function allOutput(): string {
  return [...logSpy.mock.calls, ...errorSpy.mock.calls]
    .map((call: unknown[]) => call.join(" "))
    .join("\n");
}

beforeEach(() => {
  process.env[KEY_ENV] = "recipe-api-key";
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new Error(`exit:${code}`);
  });
});

afterEach(() => {
  delete process.env[KEY_ENV];
  process.exitCode = undefined;
  vi.restoreAllMocks();
  setMock.mockReset();
  listMock.mockReset();
  deleteMock.mockReset();
  clientFactoryMock.mockClear();
});

describe("presentSecretError", () => {
  it.each([[401], [403]])("appends the one-line guidance once on HTTP %d", (status) => {
    const presented = presentSecretError(new SecretRequestError("not allowed", status));
    expect(presented).toContain("not allowed");
    expect(presented.match(/full-access API key/g)).toHaveLength(1);
    expect(presented).not.toContain("\n");
  });

  it.each([[200], [404], [500], [undefined]])("adds no guidance for status %s", (status) => {
    expect(presentSecretError(new SecretRequestError("plain", status))).toBe("plain");
  });

  it("escapes a control-character server message", () => {
    const presented = presentSecretError(new SecretRequestError("bad\x1b[31mmessage", 200));
    expect(presented).toBe(JSON.stringify("bad\x1b[31mmessage"));
  });

  it("redacts additional sensitive values before escaping", () => {
    const withEsc = `evil \x1b ${SENTINEL} tail`;
    const presented = presentSecretError(new SecretRequestError(withEsc, 200), [SENTINEL]);
    expect(presented).not.toContain(SENTINEL);
    expect(presented).toContain("[redacted]");
  });

  it("redacts a newline-containing sensitive value before escaping can split it", () => {
    const value = "two\nline-secret";
    const presented = presentSecretError(
      new SecretRequestError(`echo ${value} end`, 200),
      [value],
    );
    expect(presented).not.toContain("line-secret");
    expect(presented).toContain("[redacted]");
  });
});

describe("runSecretsSet", () => {
  it("sets via piped stdin and prints the exact two lines", async () => {
    setMock.mockResolvedValue(metadata);
    const result = await runSecretsSet("OPENAI_API_KEY", options, context, io());
    expect(result).toEqual({ kind: "set" });
    expect(clientFactoryMock).toHaveBeenCalledWith("https://h", "proj", "recipe-api-key");
    expect(setMock).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith("OPENAI_API_KEY", SENTINEL);
    expect(logSpy).toHaveBeenNthCalledWith(1, `${color.green("Set")} secret OPENAI_API_KEY.`);
    expect(logSpy).toHaveBeenNthCalledWith(
      2,
      'Available to hosted runs as env("OPENAI_API_KEY") from the next invocation.',
    );
  });

  it("forwards the io seams plus options.fromEnv to the value resolver", async () => {
    setMock.mockResolvedValue(metadata);
    const setIo = io({ env: { SRC: "env-value" } as NodeJS.ProcessEnv });
    await runSecretsSet("N", { ...options, fromEnv: "SRC" }, context, setIo);
    expect(setMock).toHaveBeenCalledWith("N", "env-value");
    expect(setIo.readStdin).not.toHaveBeenCalled();
  });

  it("renders a control-character name JSON-quoted in the success lines", async () => {
    setMock.mockResolvedValue(metadata);
    await runSecretsSet("BAD\x1bNAME", options, context, io());
    expect(allOutput()).toContain(JSON.stringify("BAD\x1bNAME"));
  });

  it("cancellation makes no request, prints Canceled., returns canceled, touches no exitCode", async () => {
    const result = await runSecretsSet(
      "N",
      options,
      context,
      io({ stdinIsTty: true, promptHidden: vi.fn().mockResolvedValue(undefined) }),
    );
    expect(result).toEqual({ kind: "canceled" });
    expect(setMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("Canceled.");
    expect(process.exitCode).toBeUndefined();
  });

  it("a value-source error exits without any client call", async () => {
    await expect(
      runSecretsSet("N", { ...options, fromEnv: "UNSET_VAR" }, context, io()),
    ).rejects.toThrow("exit:1");
    expect(setMock).not.toHaveBeenCalled();
    expect(allOutput()).toContain("$UNSET_VAR");
  });

  it("presents a 401 with the full-access guidance", async () => {
    setMock.mockRejectedValue(new SecretRequestError("nope", 401));
    await expect(runSecretsSet("N", options, context, io())).rejects.toThrow("exit:1");
    expect(allOutput()).toContain("full-access API key");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("never prints the value on a hostile already-redacted failure", async () => {
    setMock.mockRejectedValue(new SecretRequestError("server said [redacted]", 500));
    await expect(runSecretsSet("N", options, context, io())).rejects.toThrow("exit:1");
    expect(allOutput()).not.toContain(SENTINEL);
  });
});

describe("runSecretsList", () => {
  it("renders the exact table", async () => {
    listMock.mockResolvedValue([
      metadata,
      { name: "S", createdAt: "2026-05-01T00:00:00.000Z", updatedAt: "2026-06-02T00:00:00.000Z" },
    ]);
    await runSecretsList(options, context);
    const expected = [
      "Name".padEnd(16) + "Created".padEnd(12) + "Updated",
      "OPENAI_API_KEY".padEnd(16) + "2026-08-09".padEnd(12) + "2026-08-09",
      "S".padEnd(16) + "2026-05-01".padEnd(12) + "2026-06-02",
    ].join("\n");
    expect(logSpy).toHaveBeenCalledWith(expected);
  });

  it("renders a control-character name JSON-quoted", async () => {
    listMock.mockResolvedValue([{ ...metadata, name: "BAD\x1bNAME" }]);
    await runSecretsList(options, context);
    expect(allOutput()).toContain(JSON.stringify("BAD\x1bNAME"));
    expect(allOutput()).not.toContain("\x1b");
  });

  it("renders the empty state", async () => {
    listMock.mockResolvedValue([]);
    await runSecretsList(options, context);
    expect(logSpy).toHaveBeenCalledWith(
      "No secrets set for this project. Use 'agency remote secrets set <NAME>' to add one.",
    );
  });

  it("prints no partial table on failure", async () => {
    listMock.mockRejectedValue(new SecretRequestError("boom", 500));
    await expect(runSecretsList(options, context)).rejects.toThrow("exit:1");
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("runSecretsRm", () => {
  it("deletes and reports the removal", async () => {
    deleteMock.mockResolvedValue(metadata);
    await runSecretsRm("OPENAI_API_KEY", options, context);
    expect(deleteMock).toHaveBeenCalledWith("OPENAI_API_KEY");
    expect(logSpy).toHaveBeenCalledWith(`${color.green("Removed")} secret OPENAI_API_KEY.`);
  });

  it("renders a control-character name JSON-quoted in the success line", async () => {
    deleteMock.mockResolvedValue(metadata);
    await runSecretsRm("BAD\x1bNAME", options, context);
    expect(allOutput()).toContain(JSON.stringify("BAD\x1bNAME"));
  });

  it("passes 'Secret not found.' through without a success line", async () => {
    deleteMock.mockRejectedValue(new SecretRequestError("Secret not found.", 200));
    await expect(runSecretsRm("NOPE", options, context)).rejects.toThrow("exit:1");
    expect(allOutput()).toContain("Secret not found.");
    expect(allOutput()).not.toContain("full-access");
    expect(logSpy).not.toHaveBeenCalled();
  });
});
