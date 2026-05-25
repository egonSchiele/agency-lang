import { describe, it, expect } from "vitest";
import * as httpImpls from "../stdlib/http.js";
import * as memoryImpls from "../stdlib/memory.js";
import * as threadImpls from "../stdlib/thread.js";
import * as builtinsImpls from "../stdlib/builtins.js";
import * as uiImpls from "../stdlib/ui.js";
import * as shellImpls from "../stdlib/shell.js";
import * as systemImpls from "../stdlib/system.js";
import * as speechImpls from "../stdlib/speech.js";
import * as browserUseImpls from "../stdlib/browserUse.js";
import * as oauthImpls from "../stdlib/oauth.js";
import { CONTEXT_INJECTED_BUILTINS } from "./contextInjected.js";

/**
 * Drift safeguard for the context-injected builtins registry.
 *
 * For every entry in `CONTEXT_INJECTED_BUILTINS`, this asserts that:
 *
 *   1. A TS implementation with the same name is exported from the
 *      module specified by the entry's `from` field. Add new source
 *      modules to `implsByFrom` below as they're introduced.
 *
 *   2. The TS implementation's arity is `3 + params.length` — i.e. it
 *      takes leading `RuntimeContext`, `StateStack`, and `ThreadStore`
 *      arguments followed by exactly the user-visible params. This is
 *      the contract the TypeScript builder relies on when it prepends
 *      `__ctx`, `__stateStack`, and `__threads` at the call site.
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
  // Map each registry-side `from` specifier to the runtime module
  // that exports the impls. When a new context-injected source
  // module is added, append it here.
  const implsByFrom: Record<string, Record<string, unknown>> = {
    "agency-lang/stdlib-lib/memory.js": { ...memoryImpls },
    "agency-lang/stdlib-lib/thread.js": { ...threadImpls },
    "agency-lang/stdlib-lib/http.js": { ...httpImpls },
    "agency-lang/stdlib-lib/builtins.js": { ...builtinsImpls },
    "agency-lang/stdlib-lib/ui.js": { ...uiImpls },
    "agency-lang/stdlib-lib/shell.js": { ...shellImpls },
    "agency-lang/stdlib-lib/system.js": { ...systemImpls },
    "agency-lang/stdlib-lib/speech.js": { ...speechImpls },
    "agency-lang/stdlib-lib/browserUse.js": { ...browserUseImpls },
    "agency-lang/stdlib-lib/oauth.js": { ...oauthImpls },
  };

  for (const [name, def] of Object.entries(CONTEXT_INJECTED_BUILTINS)) {
    describe(name, () => {
      it("name starts with __internal_", () => {
        expect(name.startsWith("__internal_")).toBe(true);
      });

      it("name in the entry matches the registry key", () => {
        expect(def.name).toBe(name);
      });

      it("registry knows the impl's source module", () => {
        expect(implsByFrom[def.from]).toBeDefined();
      });

      it("has a TS implementation exported under the same name", () => {
        const mod = implsByFrom[def.from];
        expect(mod?.[name]).toBeTypeOf("function");
      });

      it("TS implementation arity is 3 + registry params.length", () => {
        const fn = implsByFrom[def.from]?.[name] as
          | ((...args: unknown[]) => unknown)
          | undefined;
        if (typeof fn !== "function") {
          throw new Error(`No impl found for ${name} in ${def.from}`);
        }
        expect(fn.length).toBe(3 + def.params.length);
      });
    });
  }
});
