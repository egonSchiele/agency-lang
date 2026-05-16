import { describe, it, expect } from "vitest";
import * as memoryImpls from "../stdlib/memory.js";
import { CONTEXT_INJECTED_BUILTINS } from "./contextInjected.js";

/**
 * Drift safeguard for the context-injected builtins registry.
 *
 * For every entry in `CONTEXT_INJECTED_BUILTINS`, this asserts that:
 *
 *   1. A TS implementation with the same name is exported from one of
 *      the registered stdlib modules (today only `lib/stdlib/memory.ts`,
 *      so we import that one directly; when a future entry comes from
 *      a different module, add the module here).
 *
 *   2. The TS implementation's arity is `1 + params.length` — i.e. it
 *      takes a leading `RuntimeContext` argument followed by exactly
 *      the user-visible params. This is the contract the TypeScript
 *      builder relies on when it prepends `__ctx` at the call site.
 *
 * If either invariant breaks, the registry and the impl have drifted
 * and the codegen will emit broken calls. The fix is usually either
 * to add the missing export or to align the arity.
 *
 * Variadic / default-param entries are not handled yet because no
 * current registry entry uses them. Add the case when the first one
 * lands.
 */
describe("CONTEXT_INJECTED_BUILTINS drift safeguard", () => {
  const allImpls: Record<string, unknown> = { ...memoryImpls };

  for (const [name, def] of Object.entries(CONTEXT_INJECTED_BUILTINS)) {
    describe(name, () => {
      it("name starts with __internal_", () => {
        expect(name.startsWith("__internal_")).toBe(true);
      });

      it("name in the entry matches the registry key", () => {
        expect(def.name).toBe(name);
      });

      it("has a TS implementation exported under the same name", () => {
        expect(allImpls[name]).toBeTypeOf("function");
      });

      it("TS implementation arity is 1 + registry params.length", () => {
        const fn = allImpls[name] as ((...args: unknown[]) => unknown) | undefined;
        if (typeof fn !== "function") {
          throw new Error(`No impl found for ${name}`);
        }
        expect(fn.length).toBe(1 + def.params.length);
      });
    });
  }
});
