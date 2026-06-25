import { describe, it, expect } from "vitest";
import { AgencyConfigSchema } from "./config.js";

describe("config client.providerModules", () => {
  it("accepts an array of module paths", () => {
    const parsed = AgencyConfigSchema.parse({
      client: { providerModules: ["./llama-setup.mjs", "/abs/other.mjs"] },
    });
    expect(parsed.client?.providerModules).toEqual([
      "./llama-setup.mjs",
      "/abs/other.mjs",
    ]);
  });

  it("rejects a non-array providerModules", () => {
    expect(() =>
      AgencyConfigSchema.parse({ client: { providerModules: "nope" } }),
    ).toThrow();
  });
});
