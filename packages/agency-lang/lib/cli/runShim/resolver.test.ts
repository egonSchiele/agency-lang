import { describe, it, expect } from "vitest";
import { resolve } from "./resolver.mjs";

function notFound(): Error & { code: string } {
  const err = new Error("Cannot find package") as Error & { code: string };
  err.code = "ERR_MODULE_NOT_FOUND";
  return err;
}

describe("resolver.mjs", () => {
  it("returns the default resolution when it succeeds", async () => {
    const next = async (s: string) => ({ url: `resolved:${s}`, format: null, shortCircuit: true });
    const r = await resolve("agency-lang", {}, next);
    expect(r.url).toBe("resolved:agency-lang");
  });

  it("retries with fakeParentURL for `agency-lang`", async () => {
    let calls = 0;
    const next = async (s: string, ctx: { parentURL?: string }) => {
      calls++;
      if (calls === 1) throw notFound();
      if (calls === 2 && ctx.parentURL?.includes("agency-lang")) {
        return { url: `fallback:${s}`, format: null, shortCircuit: true };
      }
      throw new Error("unexpected call");
    };
    const r = await resolve("agency-lang", {}, next);
    expect(r.url).toBe("fallback:agency-lang");
    expect(calls).toBe(2);
  });

  it("retries with fakeParentURL for `agency-lang/runtime` and similar subpaths", async () => {
    let calls = 0;
    const next = async (s: string, ctx: { parentURL?: string }) => {
      calls++;
      if (calls === 1) throw notFound();
      return { url: `fallback:${s}:${ctx.parentURL}`, format: null, shortCircuit: true };
    };
    const r = await resolve("agency-lang/runtime", {}, next);
    expect(r.url.startsWith("fallback:agency-lang/runtime:")).toBe(true);
  });

  it("does NOT retry for unrelated bare imports — propagates the original error", async () => {
    let calls = 0;
    const next = async () => {
      calls++;
      throw notFound();
    };
    await expect(resolve("lodash", {}, next)).rejects.toMatchObject({
      code: "ERR_MODULE_NOT_FOUND",
    });
    expect(calls).toBe(1); // only the initial try, no retry
  });

  it("does NOT retry for relative imports — masking those would hide user typos", async () => {
    let calls = 0;
    const next = async () => {
      calls++;
      throw notFound();
    };
    await expect(resolve("./missing.js", {}, next)).rejects.toMatchObject({
      code: "ERR_MODULE_NOT_FOUND",
    });
    expect(calls).toBe(1);
  });

  it("propagates non-ENOENT errors unchanged", async () => {
    const boom = new Error("ENOSPC");
    const next = async () => {
      throw boom;
    };
    await expect(resolve("agency-lang", {}, next)).rejects.toBe(boom);
  });
});
