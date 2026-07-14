import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AgencyConfigSchema,
  applyCliFlags,
  CONFIG_OVERRIDES_ENV,
  loadConfigSafe,
  readConfigOverrides,
  redactConfigSecrets,
  serializeConfigOverrides,
} from "./config.js";

describe("AgencyConfigSchema", () => {
  it("should accept an empty config", () => {
    const result = AgencyConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("should accept a config with existing fields", () => {
    const result = AgencyConfigSchema.safeParse({
      verbose: true,
      outDir: "dist",
      maxToolCallRounds: 5,
    });
    expect(result.success).toBe(true);
  });

  it("accepts eval runsDir config", () => {
    const result = AgencyConfigSchema.safeParse({
      eval: { runsDir: "custom-runs" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.eval?.runsDir).toBe("custom-runs");
    }
  });

  describe("memory block", () => {
    it("accepts a minimal memory block (only `dir`)", () => {
      const result = AgencyConfigSchema.safeParse({
        memory: { dir: ".agency/memory" },
      });
      expect(result.success).toBe(true);
    });

    it("accepts a fully populated memory block", () => {
      const result = AgencyConfigSchema.safeParse({
        memory: {
          dir: ".agency/memory",
          model: "gpt-4o-mini",
          autoExtract: { interval: 5 },
          compaction: { trigger: "token", threshold: 50000 },
          embeddings: { model: "text-embedding-3-small" },
        },
      });
      expect(result.success).toBe(true);
    });

    it("rejects a memory block missing the required `dir`", () => {
      const result = AgencyConfigSchema.safeParse({
        memory: { model: "gpt-4o-mini" },
      });
      expect(result.success).toBe(false);
    });

    it("rejects an invalid compaction.trigger value", () => {
      const result = AgencyConfigSchema.safeParse({
        memory: {
          dir: ".agency/memory",
          compaction: { trigger: "bogus" },
        },
      });
      expect(result.success).toBe(false);
    });

    it("rejects a non-numeric autoExtract.interval", () => {
      const result = AgencyConfigSchema.safeParse({
        memory: {
          dir: ".agency/memory",
          autoExtract: { interval: "five" },
        },
      });
      expect(result.success).toBe(false);
    });
  });
});

describe("AgencyConfig maxCallDepth key", () => {
  it("accepts a positive integer", () => {
    expect(AgencyConfigSchema.safeParse({ maxCallDepth: 4096 }).success).toBe(
      true,
    );
  });

  it("rejects 0 (would make every call throw at depth 1)", () => {
    expect(AgencyConfigSchema.safeParse({ maxCallDepth: 0 }).success).toBe(
      false,
    );
  });

  it("rejects negative and non-integer values", () => {
    expect(AgencyConfigSchema.safeParse({ maxCallDepth: -10 }).success).toBe(
      false,
    );
    expect(AgencyConfigSchema.safeParse({ maxCallDepth: 12.5 }).success).toBe(
      false,
    );
  });
});

describe("AgencyConfig maxToolCallRounds key", () => {
  it("accepts a positive integer", () => {
    expect(AgencyConfigSchema.safeParse({ maxToolCallRounds: 20 }).success).toBe(true);
  });

  it("rejects 0, negative, and non-integer (0 would silently mean 10 via `|| 10`)", () => {
    expect(AgencyConfigSchema.safeParse({ maxToolCallRounds: 0 }).success).toBe(false);
    expect(AgencyConfigSchema.safeParse({ maxToolCallRounds: -1 }).success).toBe(false);
    expect(AgencyConfigSchema.safeParse({ maxToolCallRounds: 1.5 }).success).toBe(false);
  });
});

describe("AgencyConfig typechecker key", () => {
  it("accepts the new typechecker object", () => {
    const result = AgencyConfigSchema.safeParse({
      typechecker: {
        enabled: true,
        strict: true,
        strictTypes: true,
        undefinedFunctions: "warn",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid undefinedFunctions value", () => {
    const result = AgencyConfigSchema.safeParse({
      typechecker: { undefinedFunctions: "banana" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts an empty typechecker object", () => {
    const result = AgencyConfigSchema.safeParse({ typechecker: {} });
    expect(result.success).toBe(true);
  });
});

describe("loadConfigSafe — removed options are ignored, not rejected", () => {
  it("loads an agency.json with the removed keys, and a stale wrong-typed key, without error", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-removed-"));
    const cfgPath = path.join(dir, "agency.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        excludeNodeTypes: "oops-was-string-array", // stale + wrong type: Zod error before removal, ignored after
        excludeBuiltinFunctions: ["write"],
        allowedFetchDomains: ["api.example.com"],
        disallowedFetchDomains: ["blocked.com"],
        outDir: "./dist",
      }),
    );
    const { config, error } = loadConfigSafe(cfgPath);
    expect(error).toBeUndefined();
    expect(config.outDir).toBe("./dist");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("applyCliFlags", () => {
  it("--trace <file> sets trace + traceFile", () => {
    const out = applyCliFlags({}, { trace: "out.trace" });
    expect(out.trace).toBe(true);
    expect(out.traceFile).toBe("out.trace");
    expect(out.traceDir).toBeUndefined();
  });

  it("bare --trace with an input derives <input>.trace (agency run)", () => {
    const out = applyCliFlags({}, { trace: true }, "prog.agency");
    expect(out.traceFile).toBe("prog.trace");
  });

  it("bare or empty --trace with no input uses traceDir='.' (bundled agent)", () => {
    expect(applyCliFlags({}, { trace: true }).traceDir).toBe(".");
    // Empty attached (--trace=) must behave like bare, not set traceFile="".
    expect(applyCliFlags({}, { trace: "" }).traceDir).toBe(".");
    expect(applyCliFlags({}, { trace: "" }).traceFile).toBeUndefined();
  });

  it("--log <path> sets log.logFile and enables observability, preserving log.host", () => {
    const out = applyCliFlags({ log: { host: "https://h" } }, { logFile: "x" });
    expect(out.log).toEqual({ host: "https://h", logFile: "x" });
    expect(out.observability).toBe(true);
  });

  it("--log stdout sets log.host=stdout, blanks any file sink, and enables observability", () => {
    const out = applyCliFlags({ log: { host: "https://h", logFile: "x" } }, { logStdout: true });
    // logFile blanked to "" so it overrides an agency.json logFile at merge time.
    expect(out.log).toEqual({ host: "stdout", logFile: "" });
    expect(out.observability).toBe(true);
  });

  it("--strict sets strict AND strictTypes", () => {
    expect(applyCliFlags({}, { strict: true }).typechecker).toEqual({
      strict: true,
      strictTypes: true,
    });
  });

  it("--max-tool-call-rounds sets the top-level maxToolCallRounds", () => {
    expect(applyCliFlags({}, { maxToolCallRounds: 20 }).maxToolCallRounds).toBe(20);
  });

  it("--max-tool-result-chars sets client.maxToolResultChars, preserving other client fields", () => {
    const out = applyCliFlags({ client: { defaultModel: "gpt" } }, { maxToolResultChars: 50000 });
    expect(out.client).toEqual({ defaultModel: "gpt", maxToolResultChars: 50000 });
  });

  it("keeps maxToolResultChars=0 (0 disables the cap, not falsy-skipped)", () => {
    expect(applyCliFlags({}, { maxToolResultChars: 0 }).client?.maxToolResultChars).toBe(0);
  });

  it("does not mutate the input config", () => {
    const input = {};
    applyCliFlags(input, { strict: true, logFile: "x", trace: "t", maxToolCallRounds: 5 });
    expect(input).toEqual({});
  });
});

describe("config overrides env round-trip", () => {
  it("serialize → read yields the same Partial<AgencyConfig>", () => {
    const overrides = { trace: true, traceDir: ".", observability: true, log: { logFile: "l.jsonl" } };
    const env = { [CONFIG_OVERRIDES_ENV]: serializeConfigOverrides(overrides) };
    expect(readConfigOverrides(env)).toEqual(overrides);
  });

  it("returns {} for an absent value without warning", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(readConfigOverrides({})).toEqual({});
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns {} and warns (never throws) for unparseable JSON", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(readConfigOverrides({ [CONFIG_OVERRIDES_ENV]: "not json" })).toEqual({});
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("unparseable"));
    spy.mockRestore();
  });

  it("returns {} and warns for a schema-violating field", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(readConfigOverrides({ [CONFIG_OVERRIDES_ENV]: '{"maxCallDepth":-1}' })).toEqual({});
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("invalid"));
    spy.mockRestore();
  });
});

describe("redactConfigSecrets", () => {
  it("masks log.apiKey and client.apiKey.* while keeping other fields", () => {
    const redacted = redactConfigSecrets({
      outDir: "./dist",
      log: { host: "https://h", apiKey: "sk-secret-1234" },
      client: { defaultModel: "gpt", apiKey: { openAi: "sk-openai-abcd", anthropic: "x" } },
    });
    expect(redacted.outDir).toBe("./dist");
    expect(redacted.log?.host).toBe("https://h");
    expect(redacted.log?.apiKey).toBe("•••1234");
    expect(redacted.client?.apiKey?.openAi).toBe("•••abcd");
    expect(redacted.client?.apiKey?.anthropic).toBe("•••"); // <=4 chars fully masked
    expect(redacted.client?.defaultModel).toBe("gpt");
  });

  it("does not mutate the input", () => {
    const input = { log: { apiKey: "sk-secret-1234" } };
    redactConfigSecrets(input);
    expect(input.log.apiKey).toBe("sk-secret-1234");
  });
});
