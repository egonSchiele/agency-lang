import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Mock compile to avoid needing the full pipeline
vi.mock("@/cli/commands.js", () => ({
  compile: vi.fn(),
}));

// Mock chokidar — use vi.hoisted so mocks are available in the hoisted vi.mock factory
const { mockOn, mockClose, mockWatch } = vi.hoisted(() => {
  const mockOn = vi.fn().mockReturnThis();
  const mockClose = vi.fn().mockResolvedValue(undefined);
  const mockWatch = vi.fn(() => ({
    on: mockOn,
    close: mockClose,
  }));
  return { mockOn, mockClose, mockWatch };
});
vi.mock("chokidar", () => ({
  default: { watch: mockWatch },
  watch: mockWatch,
}));

import { watchAndCompile } from "./watch.js";
import { compile } from "@/cli/commands.js";
import chokidar from "chokidar";

describe("watchAndCompile", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    mockOn.mockReturnThis();
    mockClose.mockResolvedValue(undefined);
    mockWatch.mockReturnValue({ on: mockOn, close: mockClose });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-watch-test-"));
    fs.writeFileSync(path.join(tmpDir, "test.agency"), "node main() {}");
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should do an initial compile of all inputs", async () => {
    await watchAndCompile({}, [tmpDir], { ts: false });

    expect(compile).toHaveBeenCalledWith({}, tmpDir, undefined, { ts: false });
  });

  it("should set up a chokidar watcher on inputs", async () => {
    await watchAndCompile({}, [tmpDir], { ts: false });

    expect(chokidar.watch).toHaveBeenCalledWith(
      [tmpDir],
      expect.objectContaining({
        ignored: expect.any(Function),
        ignoreInitial: true,
      }),
    );
  });

  it("should filter to only .agency files", async () => {
    await watchAndCompile({}, [tmpDir], { ts: false });

    const call = vi.mocked(chokidar.watch).mock.calls[0];
    const ignored = call[1]!.ignored as (path: string, stats?: fs.Stats) => boolean;

    // Directories should NOT be ignored (so we recurse into them)
    expect(ignored("src/", { isFile: () => false } as fs.Stats)).toBe(false);

    // .agency files should NOT be ignored
    expect(ignored("test.agency", { isFile: () => true } as fs.Stats)).toBe(false);

    // Non-.agency files SHOULD be ignored
    expect(ignored("test.js", { isFile: () => true } as fs.Stats)).toBe(true);
  });

  it("should recompile on change events", async () => {
    await watchAndCompile({}, [tmpDir], { ts: false });

    // Find the 'change' handler
    const changeCall = mockOn.mock.calls.find((c) => c[0] === "change");
    expect(changeCall).toBeDefined();
    const changeHandler = changeCall![1];

    // Simulate a change event
    vi.mocked(compile).mockClear();
    changeHandler("test.agency");
    vi.advanceTimersByTime(150);

    expect(compile).toHaveBeenCalledWith({}, "test.agency", undefined, {
      ts: false,
    });
  });

  it("should recompile on add events", async () => {
    await watchAndCompile({}, [tmpDir], { ts: false });

    const addCall = mockOn.mock.calls.find((c) => c[0] === "add");
    expect(addCall).toBeDefined();
    const addHandler = addCall![1];

    vi.mocked(compile).mockClear();
    addHandler("new-file.agency");
    vi.advanceTimersByTime(150);

    expect(compile).toHaveBeenCalledWith({}, "new-file.agency", undefined, {
      ts: false,
    });
  });

  it("should survive compilation errors", async () => {
    await watchAndCompile({}, [tmpDir], { ts: false });

    const changeCall = mockOn.mock.calls.find((c) => c[0] === "change");
    const changeHandler = changeCall![1];

    // Make compile throw
    vi.mocked(compile).mockImplementation(() => {
      throw new Error("parse error");
    });

    // Should not throw — advance timers to trigger the debounced compile
    changeHandler("bad.agency");
    expect(() => vi.advanceTimersByTime(150)).not.toThrow();
  });

  it("should return a close function", async () => {
    const close = await watchAndCompile({}, [tmpDir], { ts: false });

    await close();
    expect(mockClose).toHaveBeenCalled();
  });
});
