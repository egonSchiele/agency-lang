import { transformSync } from "esbuild";

/**
 * Turn TypeScript into JavaScript, and rewrite every `async` function into
 * promise code so each `await` becomes a `.then` call.
 *
 * The runtime keeps its context with `PromiseContextStorage`, which restores
 * the context inside `.then` callbacks. A real `await` is syntax that no
 * library can attach to, so code that still has one loses its context at the
 * first pause. Every file the compiler emits goes through this function.
 *
 * esbuild refuses to rewrite a file that has a top-level `await`, so the
 * input must not have one.
 *
 * See docs/dev/runtime/promise-context-storage.md.
 */
export function transpileToJs(tsCode: string): string {
  const result = transformSync(tsCode, {
    loader: "ts",
    format: "esm",
    supported: {
      "async-await": false,
      "async-generator": false,
      "for-await": false,
    },
  });
  return result.code;
}
