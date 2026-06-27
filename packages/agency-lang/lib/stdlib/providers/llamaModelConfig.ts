import path from "node:path";

/** Split a resolved `.gguf` path into the `{ model, llamaCppModelDir }` shape
 *  `smoltalk-llama-cpp`'s `LlamaCPP` expects. Pure + dependency-free so it is
 *  unit-testable without the optional package installed. */
export function splitModelPath(ggufPath: string): { model: string; llamaCppModelDir: string } {
  return { model: path.basename(ggufPath), llamaCppModelDir: path.dirname(ggufPath) };
}
