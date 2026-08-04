import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createServeHandler } from "./createServeHandler.js";

// A hand-written stand-in for a compiled Agency module. It exports the same
// generated symbols discoverExports + the adapter read from a real compile:
// node functions returning { data }, __<node>NodeParams, __toolRegistry,
// hasInterrupts, respondToInterrupts. Written as a `.mjs` file (below) so Node
// always treats it as ESM regardless of directory — a `.js` file under
// os.tmpdir() would rely on Node's syntax auto-detection, which is
// version-dependent. This fixture imports nothing, so it needs no node_modules.
function fixtureSource(version: string): string {
  return `
// One exported function (via __toolRegistry + __invokeFunction) so the
// factory's /function path — discoverExports + makeInvoker picking up
// __invokeFunction — is exercised, not only the node path.
export const __toolRegistry = {
  add: {
    name: "add",
    module: "agent",
    exported: true,
    params: [{ name: "a" }, { name: "b" }],
    toolDefinition: { name: "add", description: "Add two numbers", schema: null },
  },
};
export function __invokeFunction(fn, namedArgs) {
  if (fn.name === "add") {
    return namedArgs.a + namedArgs.b;
  }
  throw new Error("unknown function: " + fn.name);
}
export const __mainNodeParams = ["message"];
export const __needsApprovalNodeParams = [];
export async function main(message) {
  return { data: { echo: message, version: ${JSON.stringify(version)} } };
}
export async function needsApproval() {
  return { data: [{ type: "interrupt", effect: "std::read", message: "ok?", origin: "agent", interruptId: "fixture-int-1", runId: "fixture-run-1", data: null }] };
}
export function hasInterrupts(data) {
  return Array.isArray(data) && data.length > 0 && data.every((item) => item && item.type === "interrupt");
}
export async function respondToInterrupts(interrupts, responses) {
  return { data: { resumed: true, responses } };
}
// Serve-only invokers (a current compile exports these; discoverExports and
// createServeHandler now require them). Each returns a ServedInvocationOutcome.
const __zeroUsage = { pricedCost: 0, inputTokens: 0, outputTokens: 0, unknownCostCallCount: 0, pricingComplete: true };
function __returned(value) { return { status: "returned", value, usage: __zeroUsage, usageComplete: true }; }
export async function __invokeFunctionForServe(fn, namedArgs) {
  return __returned(__invokeFunction(fn, namedArgs));
}
export async function __invokeNodeForServe(nodeName, data) {
  if (nodeName === "main") return __returned(await main(data.message));
  if (nodeName === "needsApproval") return __returned(await needsApproval());
  throw new Error("unknown node: " + nodeName);
}
export async function __respondToInterruptsForServe(interrupts, responses) {
  return __returned(await respondToInterrupts(interrupts, responses));
}
`;
}

let tmpDir: string;
let modulePath: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "serve-handler-"));
  modulePath = path.join(tmpDir, "agent.mjs");
  fs.writeFileSync(modulePath, fixtureSource("v1"), "utf-8");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function baseOptions() {
  return {
    moduleId: "agent",
    exportedNodeNames: ["main", "needsApproval"],
    version: "1",
  };
}

describe("createServeHandler", () => {
  it("serves /list with the exported nodes and their params", async () => {
    const handler = await createServeHandler(modulePath, baseOptions());
    const res = await handler("GET", "/list", undefined);
    expect(res.status).toBe(200);
    const body = res.body as { nodes: { name: string; parameters: string[] }[] };
    const main = body.nodes.find((n) => n.name === "main");
    expect(main?.parameters).toEqual(["message"]);
  });

  it("invokes a node and returns its value", async () => {
    const handler = await createServeHandler(modulePath, baseOptions());
    const res = await handler("POST", "/node/main", { message: "hi" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, value: { echo: "hi", version: "v1" } });
  });

  it("lists and invokes an exported function through the factory", async () => {
    const handler = await createServeHandler(modulePath, baseOptions());

    const list = await handler("GET", "/list", undefined);
    const listBody = list.body as { functions: { name: string }[] };
    expect(listBody.functions.map((f) => f.name)).toContain("add");

    const res = await handler("POST", "/function/add", { a: 2, b: 3 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, value: 5 });
  });

  it("throws a clear error when the target is not a compiled Agency serve module", async () => {
    const badPath = path.join(tmpDir, "bad.mjs");
    fs.writeFileSync(badPath, "export const nothing = 1;\n", "utf-8");
    await expect(
      createServeHandler(badPath, { ...baseOptions(), version: "1" }),
    ).rejects.toThrow(/not a compiled Agency serve module/);
  });

  it("returns the interrupts payload, then resumes to the final value", async () => {
    const handler = await createServeHandler(modulePath, baseOptions());
    const paused = await handler("POST", "/node/needsApproval", {});
    const pausedBody = paused.body as { success: boolean; value: { interrupts: unknown[] } };
    expect(Array.isArray(pausedBody.value.interrupts)).toBe(true);

    // Echo the exact interrupt array from the pause, as a real client would.
    const resumed = await handler("POST", "/resume", {
      interrupts: pausedBody.value.interrupts,
      responses: [{ type: "approve" }],
    });
    const resumedBody = resumed.body as { success: boolean; value: { resumed: boolean } };
    expect(resumedBody.value.resumed).toBe(true);
  });

  it("cache-busts on version change: re-written module loads new code", async () => {
    const first = await createServeHandler(modulePath, { ...baseOptions(), version: "1" });
    const firstRes = await first("POST", "/node/main", { message: "x" });
    expect((firstRes.body as { value: { version: string } }).value.version).toBe("v1");

    fs.writeFileSync(modulePath, fixtureSource("v2"), "utf-8");
    const second = await createServeHandler(modulePath, { ...baseOptions(), version: "2" });
    const secondRes = await second("POST", "/node/main", { message: "x" });
    expect((secondRes.body as { value: { version: string } }).value.version).toBe("v2");
  });
});
