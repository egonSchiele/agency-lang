import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { _setSecret, _getSecret, _deleteSecret, _isKeyringAvailable } from "../keyring.js";

// Mock child_process
const mockExecFile = vi.fn();
const mockSpawn = vi.fn();

vi.mock("child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const originalPlatform = process.platform;
afterAll(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
});

describe("keyring (macOS)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    // Default: execFile succeeds
    mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: "", stderr: "" });
    });
  });

  describe("_setSecret", () => {
    it("calls security add-generic-password with correct args", async () => {
      // First call is delete (may fail), second is add
      let callCount = 0;
      mockExecFile.mockImplementation((_cmd: string, args: string[], cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
        callCount++;
        if (callCount === 1) {
          // delete call - can fail
          cb(new Error("not found"), { stdout: "", stderr: "" });
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
      });

      await _setSecret("my-key", "my-value");

      const addCall = mockExecFile.mock.calls[1];
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
      mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
        callCount++;
        if (callCount === 1) cb(new Error("not found"), { stdout: "", stderr: "" });
        else cb(null, { stdout: "", stderr: "" });
      });

      await _setSecret("key", "val", "my-app");

      const addCall = mockExecFile.mock.calls[1];
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
      mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: "my-secret-value\n", stderr: "" });
      });

      const result = await _getSecret("my-key");
      expect(result).toBe("my-secret-value");
    });

    it("returns null when secret not found", async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
        cb(new Error("security: SecKeychainSearchCopyNext: not found"), { stdout: "", stderr: "" });
      });

      const result = await _getSecret("nonexistent");
      expect(result).toBeNull();
    });

    it("uses correct security command", async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: "val", stderr: "" });
      });

      await _getSecret("test-key", "custom-svc");

      const [cmd, args] = mockExecFile.mock.calls[0];
      expect(cmd).toBe("security");
      expect(args).toContain("find-generic-password");
      expect(args).toContain("-s");
      expect(args).toContain("custom-svc");
      expect(args).toContain("-a");
      expect(args).toContain("test-key");
      expect(args).toContain("-w");
    });
  });

  describe("_deleteSecret", () => {
    it("returns true when deleted", async () => {
      const result = await _deleteSecret("my-key");
      expect(result).toBe(true);
    });

    it("returns false when not found", async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
        cb(new Error("not found"), { stdout: "", stderr: "" });
      });

      const result = await _deleteSecret("nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("_isKeyringAvailable", () => {
    it("returns true when security command works", async () => {
      expect(await _isKeyringAvailable()).toBe(true);
    });

    it("returns false when security command fails", async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
        cb(new Error("command not found"), { stdout: "", stderr: "" });
      });

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
