import { describe, it, expect } from "vitest";
import { resolve, type ResolveContext } from "./resolver.mjs";

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

  it("preserves the original error when the asynchronous fallback rejects", async () => {
    const original = notFound();
    const fallback = new Error("Fallback could not resolve the package");
    let calls = 0;
    const next = () => {
      calls += 1;
      return Promise.reject(calls === 1 ? original : fallback);
    };
    await expect(resolve("agency-lang/runtime", {}, next)).rejects.toBe(original);
    expect(calls).toBe(2);
  });
});

describe("synchronous resolver", () => {
  it("returns the resolution directly without a Promise", () => {
    const resolved = { url: "resolved:agency-lang", format: "module" };
    const result = resolve("agency-lang", {}, () => resolved);
    expect(result).toBe(resolved);
    expect(result).not.toBeInstanceOf(Promise);
  });

  it.each(["agency-lang", "agency-lang/runtime"])(
    "retries %s with the package parent and preserves the remaining context",
    (specifier) => {
      const context = {
        parentURL: "file:///outside/main.mjs",
        conditions: ["node", "import"],
        importAttributes: {},
      };
      const contexts: ResolveContext[] = [];
      const resolved = { url: "file:///install/runtime.mjs", format: "module" };
      const next = (requested: string, received: ResolveContext) => {
        expect(requested).toBe(specifier);
        contexts.push(received);
        if (contexts.length === 1) {
          throw notFound();
        }
        return resolved;
      };
      expect(resolve(specifier, context, next)).toBe(resolved);
      expect(contexts).toHaveLength(2);
      expect(contexts[0]).toBe(context);
      expect(contexts[1]).toEqual({
        ...context,
        parentURL: expect.stringMatching(/^file:.*\/package\.json$/),
      });
      expect(contexts[1].parentURL).not.toBe(context.parentURL);
      expect(context.parentURL).toBe("file:///outside/main.mjs");
    },
  );

  it.each(["lodash", "./missing.js", "agency-lang-other"])("does not retry %s", (specifier) => {
    const original = notFound();
    let calls = 0;
    const next = () => {
      calls += 1;
      throw original;
    };
    expect(() => resolve(specifier, {}, next)).toThrow(original);
    expect(calls).toBe(1);
  });

  it("propagates other errors without retrying", () => {
    const original = new Error("Invalid package configuration");
    let calls = 0;
    const next = () => {
      calls += 1;
      throw original;
    };
    expect(() => resolve("agency-lang", {}, next)).toThrow(original);
    expect(calls).toBe(1);
  });

  it("preserves the original error when the synchronous fallback throws", () => {
    const original = notFound();
    const fallback = new Error("Fallback could not resolve the package");
    let calls = 0;
    const next = () => {
      calls += 1;
      throw calls === 1 ? original : fallback;
    };
    let received: unknown;
    try {
      resolve("agency-lang/runtime", {}, next);
    } catch (error) {
      received = error;
    }
    expect(received).toBe(original);
    expect(calls).toBe(2);
  });
});
