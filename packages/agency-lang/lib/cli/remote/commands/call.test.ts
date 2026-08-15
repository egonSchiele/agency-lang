import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Interrupt } from "@/runtime/interrupts.js";

const fakeClient = {
  fetchManifest: vi.fn(),
  invokeNode: vi.fn(),
  invokeFunction: vi.fn(),
  resume: vi.fn(),
};
vi.mock("../../statelog/serveClient.js", () => ({
  createServeClient: () => fakeClient,
  ServeRequestError: class ServeRequestError extends Error {},
}));

const { runCall } = await import("./call.js");

class ProcessExit extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

let dir: string;
let configPath: string;
let logs: string[];
let errs: string[];
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-call-"));
  configPath = path.join(dir, "agency.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ remote: { serveUrl: "https://h/serve/u/p/agent.agency" } }),
  );
  process.env.STATELOG_API_KEY = "key";
  logs = [];
  errs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errs.push(a.join(" "));
  });
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ProcessExit(code ?? 0);
  }) as never);
  for (const fn of Object.values(fakeClient)) fn.mockReset();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete process.env.STATELOG_API_KEY;
});

const context = () => ({ config: {}, configPath });
function intr(effect: string): Interrupt {
  return {
    type: "interrupt",
    effect,
    message: "",
    data: null,
    origin: "",
    interruptId: `i-${effect}`,
    runId: "r",
  };
}

describe("runCall", () => {
  it("node path: drives the interrupt loop and prints the final value", async () => {
    fakeClient.invokeNode.mockResolvedValueOnce({ data: [intr("X")] });
    fakeClient.resume.mockResolvedValueOnce({ data: "ok" });
    await runCall("main", { arg: ["q=hi"], approve: "X" }, context());
    expect(fakeClient.resume).toHaveBeenCalledOnce();
    expect(logs.join("\n")).toContain("ok");
  });

  it("no interrupt flag + surfaced interrupt: reports unhandled and exits", async () => {
    fakeClient.invokeNode.mockResolvedValueOnce({ data: [intr("X")] });
    await expect(runCall("main", {}, context())).rejects.toBeInstanceOf(ProcessExit);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fakeClient.resume).not.toHaveBeenCalled();
    expect(errs.join("\n")).toContain("was not handled");
  });

  it("function is one-shot: prints the value, never resumes", async () => {
    fakeClient.invokeFunction.mockResolvedValueOnce(5);
    await runCall("add", { function: true, arg: ["a=2", "b=3"] }, context());
    expect(logs.join("\n")).toContain("5");
    expect(fakeClient.resume).not.toHaveBeenCalled();
  });

  it("a failed function (serve client throws) exits non-zero, not a success result", async () => {
    fakeClient.invokeFunction.mockRejectedValueOnce(new Error("boom"));
    await expect(runCall("f", { function: true }, context())).rejects.toBeInstanceOf(ProcessExit);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logs.join("\n")).not.toContain("Result:");
  });

  it("a resume failure becomes one clean CLI error", async () => {
    fakeClient.invokeNode.mockResolvedValueOnce({ data: [intr("X")] });
    fakeClient.resume.mockRejectedValueOnce(new Error("resume boom"));
    await expect(runCall("main", { approve: "X" }, context())).rejects.toBeInstanceOf(ProcessExit);
    expect(errs.join("\n")).toContain("resume boom");
  });

  it("an invalid policy fails before any invoke", async () => {
    await expect(
      runCall("main", { policy: "definitely-not-a-policy" }, context()),
    ).rejects.toBeInstanceOf(ProcessExit);
    expect(fakeClient.invokeNode).not.toHaveBeenCalled();
  });
});
