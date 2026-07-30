import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AgencyRunner, type NodeRunner } from "./agencyRunner.js";

const fakeRunner = (data: unknown): NodeRunner => vi.fn(async () => ({ data }));

describe("AgencyRunner", () => {
  it("run() returns the node's raw value", async () => {
    const runner = new AgencyRunner({}, fakeRunner("New Delhi"));
    expect(await runner.run("./agent.agency", "main", ["India"])).toBe("New Delhi");
  });

  it("runStructured() validates the return against a schema", async () => {
    const runner = new AgencyRunner({}, fakeRunner({ score: 0.5, reasoning: "ok" }));
    const schema = z.object({ score: z.number(), reasoning: z.string() });
    expect(await runner.runStructured("./judge.agency", "main", [], schema)).toEqual({ score: 0.5, reasoning: "ok" });
  });

  it("runStructured() throws a clear error on a schema mismatch", async () => {
    const runner = new AgencyRunner({}, fakeRunner({ score: "nope" }));
    await expect(runner.runStructured("./judge.agency", "main", [], z.object({ score: z.number() }))).rejects.toThrow(/judge\.agency.*schema/i);
  });
});
