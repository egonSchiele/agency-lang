import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import {
  _setSecret,
  _getSecret,
  _deleteSecret,
  _isKeyringAvailable,
  getSecret,
  passwordFromSecurityOutput,
  readSecret,
  securityCommandLine,
} from "../keyring.js";

import { PROGRAM_OUTPUT_LIMIT } from "../abortable.js";
import { exited, failed, programRun, testDefaultHost, testPlatform } from "./fakeSubprocess.js";

/** What `security` prints when the item doesn't exist. */
const NOT_FOUND =
  "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.";

/** What `security find-generic-password -g` prints on stderr for `value`. */
function found(value: string) {
  return exited("", `keychain: "login"\npassword: "${value}"\n`);
}

// The host's subprocess part, mocked: `mockRun` answers each program.
const mockRun = vi.fn();

vi.mock("../../host/node/nodeSubprocess.js", () => ({
  nodeSubprocess: {
    run: (...args: unknown[]) => mockRun(...args),
    start: vi.fn(),
  },
}));
vi.mock("#default-host", () => ({ defaultHost: () => testDefaultHost() }));

/** The program and args of the `index`th run. */
function call(index: number): [string, string[]] {
  const { program, args } = programRun(mockRun, index);
  return [program, args];
}

afterAll(() => {
  testPlatform.os = "macos";
});

describe("keyring (macOS)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testPlatform.os = "macos";
    // Default: every program exits with 0
    mockRun.mockImplementation(async () => exited());
  });

  describe("_setSecret", () => {
    it("stores the secret on stdin, never in the arguments", async () => {
      await _setSecret("my-key", 's3cr$t "q" \\b');

      expect(mockRun).toHaveBeenCalledTimes(1);
      const [cmd, args] = call(0);
      expect(cmd).toBe("security");
      expect(args).toEqual(["-i"]);
      expect(mockRun.mock.calls[0][1].input).toBe(
        '"add-generic-password" "-U" "-s" "agency-lang" "-a" "my-key" "-w" "s3cr$t \\"q\\" \\\\b"\n',
      );
      expect(args.some((arg) => arg.includes("s3cr"))).toBe(false);
    });

    it("uses custom service name", async () => {
      await _setSecret("key", "val", "my-app");

      expect(mockRun.mock.calls[0][1].input).toContain('"-s" "my-app"');
    });

    it("updates in place, with no delete first", async () => {
      await _setSecret("key", "val");

      for (let index = 0; index < mockRun.mock.calls.length; index++) {
        expect(call(index)[1]).not.toContain("delete-generic-password");
      }
      expect(mockRun.mock.calls[0][1].input).toContain('"-U"');
    });

    it("refuses a value with a line break", async () => {
      await expect(_setSecret("k", "a\nb")).rejects.toThrow("must be one line");
      expect(mockRun).not.toHaveBeenCalled();
    });

    it("a failed store throws", async () => {
      mockRun.mockImplementation(async () => failed("add-generic-password: returned 2", 2));

      await expect(_setSecret("k", "v")).rejects.toThrow();
    });

    it("a failed store never repeats the secret", async () => {
      mockRun.mockImplementation(async () =>
        failed('add-generic-password: bad input near "sk-secret"', 2),
      );

      const error = await _setSecret("k", "sk-secret").catch((caught: Error) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("sk-secret");
    });

    it("throws on empty key", async () => {
      await expect(_setSecret("", "value")).rejects.toThrow("key must not be empty");
    });

    it("throws on empty value", async () => {
      await expect(_setSecret("key", "")).rejects.toThrow("value must not be empty");
    });
  });

  describe("_getSecret", () => {
    it("returns the secret value", async () => {
      mockRun.mockImplementation(async () => found("my-secret-value"));

      const result = await _getSecret("my-key");
      expect(result).toBe("my-secret-value");
    });

    it("returns null when secret not found", async () => {
      mockRun.mockImplementation(async () => failed(NOT_FOUND, 44));

      const result = await _getSecret("nonexistent");
      expect(result).toBeNull();
    });

    it("uses correct security command", async () => {
      mockRun.mockImplementation(async () => found("val"));

      await _getSecret("test-key", "custom-svc");

      const [cmd, args] = call(0);
      expect(cmd).toBe("security");
      expect(args).toContain("find-generic-password");
      expect(args).toContain("-s");
      expect(args).toContain("custom-svc");
      expect(args).toContain("-a");
      expect(args).toContain("test-key");
      expect(args).toContain("-g");
      expect(args).not.toContain("-w");
    });

    it("fails when the keyring can't be read", async () => {
      mockRun.mockImplementation(async () => failed("User interaction is not allowed.", 51));

      await expect(_getSecret("k")).rejects.toThrow("51");
    });
  });

  describe("_getSecret with a timeout", () => {
    it("passes the timeout to the subprocess", async () => {
      mockRun.mockImplementation(async () => found("tok"));
      expect(await _getSecret("k", "svc", 1234)).toBe("tok");
      expect(mockRun.mock.calls[0][1]).toEqual({
        timeoutMs: 1234,
        maxOutputBytes: PROGRAM_OUTPUT_LIMIT,
      });
    });

    it("passes no timeout when none is given", async () => {
      mockRun.mockImplementation(async () => found("tok"));
      await _getSecret("k");
      expect(mockRun.mock.calls[0][1]).toEqual({ maxOutputBytes: PROGRAM_OUTPUT_LIMIT });
    });

    it("fails for a lookup killed at the deadline, which getSecret reads as null", async () => {
      mockRun.mockImplementation(async () => ({
        ...failed("", null),
        signal: "SIGTERM",
        timedOut: true,
      }));
      await expect(_getSecret("k", "svc", 10)).rejects.toThrow();
      expect(await getSecret(testDefaultHost(), "k", "svc", 10)).toBeNull();
    });
  });

  describe("_deleteSecret", () => {
    it("returns true when deleted", async () => {
      const result = await _deleteSecret("my-key");
      expect(result).toBe(true);
    });

    it("returns false when not found", async () => {
      mockRun.mockImplementation(async () => failed("not found"));

      const result = await _deleteSecret("nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("_isKeyringAvailable", () => {
    it("returns true when security command works", async () => {
      expect(await _isKeyringAvailable()).toBe(true);
    });

    it("returns false when security command fails", async () => {
      mockRun.mockImplementation(async () => failed("command not found"));

      expect(await _isKeyringAvailable()).toBe(false);
    });
  });
});

describe("keyring (WSL)", () => {
  // WSL reports as "wsl", and secret-tool runs there as on any Linux.
  beforeEach(() => {
    vi.clearAllMocks();
    testPlatform.os = "wsl";
    mockRun.mockImplementation(async () => exited("stored-value\n"));
  });

  it("reads through secret-tool", async () => {
    expect(await _getSecret("k", "svc")).toBe("stored-value");
    const [cmd, args] = call(0);
    expect(cmd).toBe("secret-tool");
    expect(args).toEqual(["lookup", "service", "svc", "account", "k"]);
  });

  it("stores, deletes, and reports the keyring available", async () => {
    await _setSecret("k", "v", "svc");
    expect(call(0)[0]).toBe("secret-tool");
    expect(mockRun.mock.calls[0][1]).toEqual({ input: "v" });
    expect(await _deleteSecret("k", "svc")).toBe(true);
    expect(await _isKeyringAvailable()).toBe(true);
  });
});

describe("keyring (unsupported platform)", () => {
  beforeEach(() => {
    testPlatform.os = "windows";
  });

  it("_setSecret throws on unsupported platform", async () => {
    await expect(_setSecret("key", "val")).rejects.toThrow("not supported");
  });

  it("_getSecret throws on unsupported platform", async () => {
    await expect(_getSecret("key")).rejects.toThrow("not supported");
  });

  it("_deleteSecret throws on unsupported platform", async () => {
    await expect(_deleteSecret("key")).rejects.toThrow("not supported");
  });

  it("_isKeyringAvailable returns false", async () => {
    expect(await _isKeyringAvailable()).toBe(false);
  });
});

describe("readSecret (macOS)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testPlatform.os = "macos";
  });

  it("reads a missing item from exit 44", async () => {
    mockRun.mockImplementation(async () => failed(NOT_FOUND, 44));
    expect(await readSecret(testDefaultHost(), "k")).toEqual({ kind: "missing" });
  });

  it("reads the password from -g's stderr", async () => {
    mockRun.mockImplementation(async () => found("v"));
    expect(await readSecret(testDefaultHost(), "k")).toEqual({ kind: "found", value: "v" });
  });

  it("reads exit 44 with another error as a failure", async () => {
    mockRun.mockImplementation(async () => failed("security: some other error", 44));
    expect((await readSecret(testDefaultHost(), "k")).kind).toBe("failed");
  });

  it("a failure's reason never includes the password", async () => {
    // Answered just as the deadline hit: the password is on stderr, but
    // the lookup counts as timed out.
    mockRun.mockImplementation(async () => ({
      ...exited("", 'keychain: "login"\npassword: "sk-secret"\n'),
      timedOut: true,
    }));
    const lookup = await readSecret(testDefaultHost(), "k", "svc", 10);
    expect(lookup.kind).toBe("failed");
    expect(JSON.stringify(lookup)).not.toContain("sk-secret");
  });

  it("reads any other exit as a failure", async () => {
    mockRun.mockImplementation(async () => failed("User interaction is not allowed.", 51));
    const lookup = await readSecret(testDefaultHost(), "k");
    expect(lookup.kind).toBe("failed");
    expect(lookup.kind === "failed" ? lookup.reason : "").toContain("51");
  });

  it("a timeout is a failure", async () => {
    mockRun.mockImplementation(async () => ({ ...failed("", null), timedOut: true }));
    expect((await readSecret(testDefaultHost(), "k", "svc", 10)).kind).toBe("failed");
  });

  it("output with no password line is a failure", async () => {
    mockRun.mockImplementation(async () => exited("", 'keychain: "login"\n'));
    expect((await readSecret(testDefaultHost(), "k")).kind).toBe("failed");
  });

  it("a missing security command is unavailable", async () => {
    mockRun.mockImplementation(async () => {
      throw Object.assign(new Error("spawn security ENOENT"), { code: "ENOENT" });
    });
    const lookup = await readSecret(testDefaultHost(), "k");
    expect(lookup).toEqual({ kind: "unavailable", reason: "`security` isn't installed." });
  });
});

describe("readSecret (Linux)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testPlatform.os = "linux";
  });

  it("reads exit 1 with no output as missing", async () => {
    mockRun.mockImplementation(async () => failed("", 1));
    expect(await readSecret(testDefaultHost(), "k")).toEqual({ kind: "missing" });
  });

  it("reads exit 1 with an error as a failure", async () => {
    mockRun.mockImplementation(async () => failed("No such interface", 1));
    expect((await readSecret(testDefaultHost(), "k")).kind).toBe("failed");
  });

  it("a missing secret-tool is unavailable", async () => {
    mockRun.mockImplementation(async () => {
      throw Object.assign(new Error("spawn secret-tool ENOENT"), { code: "ENOENT" });
    });
    expect(await readSecret(testDefaultHost(), "k")).toEqual({
      kind: "unavailable",
      reason: "`secret-tool` isn't installed.",
    });
  });
});

describe("readSecret (unsupported platform)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testPlatform.os = "windows";
  });

  it("is unavailable, and runs nothing", async () => {
    expect((await readSecret(testDefaultHost(), "k")).kind).toBe("unavailable");
    expect(mockRun).not.toHaveBeenCalled();
  });
});

describe("passwordFromSecurityOutput", () => {
  it("takes a plain password as it is, even when it looks like hex", () => {
    expect(passwordFromSecurityOutput('password: "616263"\n')).toBe("616263");
  });

  it("decodes the hex form of a password with quotes and backslashes", () => {
    const line =
      'password: 0x69742773206120226B657922205C20776974682024484F4D45  "it\'s a \\"key\\" \\134 with $HOME"';
    expect(passwordFromSecurityOutput(line)).toBe('it\'s a "key" \\ with $HOME');
  });

  it("decodes the hex form of a non-ASCII password as UTF-8", () => {
    const line = 'password: 0xC3BC6EC3AF636F6465  "\\303\\274n\\303\\257code"';
    expect(passwordFromSecurityOutput(line)).toBe("ünïcode");
  });

  it("is null with no password line", () => {
    expect(passwordFromSecurityOutput('keychain: "login"\n')).toBeNull();
  });
});

describe("securityCommandLine", () => {
  it("quotes every argument, escaping quotes and backslashes", () => {
    expect(securityCommandLine(["a b", 'x"y', "c\\d", "$HOME"])).toBe(
      '"a b" "x\\"y" "c\\\\d" "$HOME"',
    );
  });

  it("refuses a line longer than security -i reads", () => {
    expect(() => securityCommandLine(["x".repeat(4001)])).toThrow("too long");
    expect(() => securityCommandLine(["x".repeat(3900)])).not.toThrow();
  });

  it("refuses an argument with a line break or NUL", () => {
    expect(() => securityCommandLine(["a\nb"])).toThrow("must be one line");
    expect(() => securityCommandLine(["a\rb"])).toThrow("must be one line");
    expect(() => securityCommandLine(["a\0b"])).toThrow("must be one line");
  });
});
