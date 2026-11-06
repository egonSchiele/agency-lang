import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../host/node/nodeSubprocess.js", () => ({
  nodeSubprocess: { run: vi.fn(async () => exited()), start: vi.fn() },
}));
vi.mock("#default-host", () => ({ defaultHost: () => testDefaultHost() }));

import { nodeSubprocess } from "../../host/node/nodeSubprocess.js";
import { exited, failed, programRun, testDefaultHost, testPlatform } from "./fakeSubprocess.js";
import { isFailure, isSuccess } from "../../runtime/result.js";
import { _pasteImage } from "../clipboard.js";

const run = nodeSubprocess.run as unknown as ReturnType<typeof vi.fn>;

describe("_pasteImage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testPlatform.os = "macos";
  });

  it("asks osascript to write the image and returns the file it named", async () => {
    const result = await _pasteImage();

    expect(isSuccess(result)).toBe(true);
    const { program, args } = programRun(run);
    expect(program).toBe("osascript");
    const file = args[args.length - 1];
    expect(result.value).toBe(file);
    expect(file).toMatch(/agency-clipboard-.+\.png$/);
  });

  it("passes the path as an argument, never inside the script", async () => {
    await _pasteImage();

    const { args } = programRun(run);
    const file = args[args.length - 1];
    const script = args.slice(0, -1).join("\n");
    expect(script).not.toContain(file);
    expect(script).toContain("item 1 of argv");
  });

  it("fails when the clipboard holds no image", async () => {
    run.mockResolvedValueOnce(failed("Can’t make some data into the expected type."));

    const result = await _pasteImage();

    expect(isFailure(result)).toBe(true);
    expect(result.error).toBe("The clipboard does not hold an image.");
  });

  it("fails on another system without running anything", async () => {
    testPlatform.os = "linux";

    const result = await _pasteImage();

    expect(isFailure(result)).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
});
