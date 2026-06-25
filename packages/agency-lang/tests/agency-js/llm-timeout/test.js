import { main, __setLLMClient } from "./agent.js";
import { writeFileSync } from "fs";

// Hang until the per-call timeout aborts the request; then reject with the
// signal's reason (the callTimeout abort) so the backend can classify it.
const client = {
  async text(config) {
    return new Promise((_resolve, reject) => {
      config.abortSignal?.addEventListener("abort", () => reject(config.abortSignal.reason));
    });
  },
  async *textStream(config) {
    const r = await this.text(config);
    yield { type: "done", result: r.value };
  },
  async embed() {
    return { success: false, error: "embed not implemented" };
  },
};

__setLLMClient(client);
const result = await main();
writeFileSync("__result.json", JSON.stringify({ data: result.data }, null, 2));
