import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { _setSecret, _getSecret, _deleteSecret, _isKeyringAvailable } from "../keyring.js";

import { exited, failed, programRun } from "./fakeSubprocess.js";

// The host's subprocess part, mocked: `mockRun` answers each program.
const mockRun = vi.fn();

vi.mock("../../host/nodeSubprocess.js", () => ({
  nodeSubprocess: {
    run: (...args: unknown[]) => mockRun(...args),
    start: vi.fn(),
  },
}));

/** The program and args of the `index`th run. */
function call(index: number): [string, string[]] {
  const { program, args } = programRun(mockRun, index);
  return [program, args];
}

const originalPlatform = process.platform;
afterAll(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
});

describe("keyring (macOS)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    // Default: every program exits with 0
    mockRun.mockImplementation(async () => exited());
  });

  describe("_setSecret", () => {
    it("calls security add-generic-password with correct args", async () => {
      // First call is delete (may fail), second is add
      let callCount = 0;
      mockRun.mockImplementation(async () => {
        callCount++;
        // The delete call can fail
        return callCount === 1 ? failed("not found") : exited();
      });

      await _setSecret("my-key", "my-value");

      const addCall = call(1);
      expect(addCall[0]).toBe("security");
      expect(addCall[1]).toContain("add-generic-password");
      expect(addCall[1]).toContain("-a");
      expect(addCall[1]).toContain("my-key");
      expect(addCall[1]).toContain("-w");
      expect(addCall[1]).toContain("my-value");
      expect(addCall[1]).toContain("-s");
      expect(addCall[1]).toContain("agency-lang");
    });

    it("uses custom service name", async () => {
      let callCount = 0;
      mockRun.mockImplementation(async () => {
        callCount++;
        return callCount === 1 ? failed("not found") : exited();
      });

      await _setSecret("key", "val", "my-app");

      const addCall = call(1);
      expect(addCall[1]).toContain("my-app");
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
      mockRun.mockImplementation(async () => exited("my-secret-value\n"));

      const result = await _getSecret("my-key");
      expect(result).toBe("my-secret-value");
    });

    it("returns null when secret not found", async () => {
      mockRun.mockImplementation(async () =>
        failed("security: SecKeychainSearchCopyNext: not found"),
      );

      const result = await _getSecret("nonexistent");
      expect(result).toBeNull();
    });

    it("uses correct security command", async () => {
      mockRun.mockImplementation(async () => exited("val"));

      await _getSecret("test-key", "custom-svc");

      const [cmd, args] = call(0);
      expect(cmd).toBe("security");
      expect(args).toContain("find-generic-password");
      expect(args).toContain("-s");
      expect(args).toContain("custom-svc");
      expect(args).toContain("-a");
      expect(args).toContain("test-key");
      expect(args).toContain("-w");
    });
  });

  describe("_getSecret with a timeout", () => {
    it("passes the timeout to the subprocess", async () => {
      mockRun.mockImplementation(async () => exited("tok\n"));
      expect(await _getSecret("k", "svc", 1234)).toBe("tok");
      expect(mockRun.mock.calls[0][1]).toEqual({ timeoutMs: 1234 });
    });

    it("passes no timeout when none is given", async () => {
      mockRun.mockImplementation(async () => exited("tok"));
      await _getSecret("k");
      expect(mockRun.mock.calls[0][1]).toEqual({});
    });

    it("reads a lookup killed at the deadline as a miss", async () => {
      mockRun.mockImplementation(async () => ({
        ...failed("", null),
        signal: "SIGTERM",
        timedOut: true,
      }));
      expect(await _getSecret("k", "svc", 10)).toBeNull();
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

describe("keyring (unsupported platform)", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
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
