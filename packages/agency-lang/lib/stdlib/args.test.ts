import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  validateSchema,
  normalizeSchema,
  preScanArgv,
  callNodeParse,
  coerceValues,
  parseStrictNumber,
  applyDefaults,
  checkGroups,
  formatHelp,
  formatError,
  _parseArgsWith,
  type ArgsSchema,
  type ParseError,
} from "./args.js";

// Test harness: each `expectExit(...)` call captures process.exit code,
// stdout, stderr, then throws a sentinel so the call site can assert
// without continuing past the would-be exit.
type ExitCapture = {
  code: number | undefined;
  stdout: string;
  stderr: string;
};

class ExitSentinel extends Error {
  constructor(public capture: ExitCapture) {
    super("__exit__");
  }
}

function withMockedProcess<T>(fn: () => T): { ran: boolean; result?: T; capture: ExitCapture } {
  const capture: ExitCapture = { code: undefined, stdout: "", stderr: "" };
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: any) => {
      capture.stdout += String(chunk);
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: any) => {
      capture.stderr += String(chunk);
      return true;
    });
  const exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation(((code?: number) => {
      capture.code = code;
      throw new ExitSentinel(capture);
    }) as never);
  try {
    const result = fn();
    return { ran: true, result, capture };
  } catch (e) {
    if (e instanceof ExitSentinel) {
      return { ran: false, capture };
    }
    throw e;
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

// Tiny helper: build a schema with one flag, override fields per test.
function oneFlag(over: Partial<ArgsSchema["flags"][string]>): ArgsSchema {
  return {
    flags: {
      name: { type: "string", ...over },
    },
  };
}

describe("validateSchema", () => {
  describe("accepts", () => {
    it("a minimal valid schema", () => {
      expect(() => validateSchema(oneFlag({}))).not.toThrow();
    });

    it("each flag type", () => {
      for (const type of ["string", "number", "boolean"] as const) {
        expect(() =>
          validateSchema({ flags: { f: { type } } }),
        ).not.toThrow();
      }
    });

    it("boolean with default: false", () => {
      expect(() =>
        validateSchema({ flags: { v: { type: "boolean", default: false } } }),
      ).not.toThrow();
    });

    it("a flag with a short alias", () => {
      expect(() =>
        validateSchema(oneFlag({ short: "n" })),
      ).not.toThrow();
    });

    it("choices on a string flag", () => {
      expect(() =>
        validateSchema(oneFlag({ choices: ["a", "b"] })),
      ).not.toThrow();
    });

    it("groups referencing declared flags", () => {
      expect(() =>
        validateSchema({
          flags: { a: { type: "boolean" }, b: { type: "boolean" } },
          groups: { exclusive: [["a", "b"]] },
        }),
      ).not.toThrow();
    });

    it("user declares own help flag with non-boolean short -h", () => {
      // When the user declares `help`, auto-help is disabled, so a
      // non-boolean -h collision is allowed.
      expect(() =>
        validateSchema({
          flags: {
            help: { type: "string" },
            host: { type: "string", short: "h" },
          },
        }),
      ).not.toThrow();
    });
  });

  describe("rejects", () => {
    it("invalid flag name (uppercase)", () => {
      expect(() =>
        validateSchema({ flags: { Name: { type: "string" } } }),
      ).toThrow(/invalid flag name "Name"/);
    });

    it("invalid flag name (leading dash)", () => {
      expect(() =>
        validateSchema({ flags: { "-name": { type: "string" } } }),
      ).toThrow(/invalid flag name/);
    });

    it("invalid flag name (contains =)", () => {
      expect(() =>
        validateSchema({ flags: { "na=me": { type: "string" } } }),
      ).toThrow(/invalid flag name/);
    });

    it("invalid type", () => {
      expect(() =>
        // @ts-expect-error — intentionally wrong
        validateSchema({ flags: { f: { type: "int" } } }),
      ).toThrow(/has invalid type "int"/);
    });

    it("short alias not exactly one character", () => {
      expect(() => validateSchema(oneFlag({ short: "nn" }))).toThrow(
        /must be exactly one character/,
      );
      expect(() => validateSchema(oneFlag({ short: "" }))).toThrow(
        /must be exactly one character/,
      );
    });

    it("duplicate short aliases", () => {
      expect(() =>
        validateSchema({
          flags: {
            name: { type: "string", short: "n" },
            number: { type: "number", short: "n" },
          },
        }),
      ).toThrow(/both declare short alias -n/);
    });

    it("default type does not match flag type", () => {
      expect(() =>
        validateSchema(oneFlag({ default: 5 })),
      ).toThrow(/has type "string" but default 5 is a number/);
      expect(() =>
        validateSchema({ flags: { p: { type: "number", default: "x" } } }),
      ).toThrow(/has type "number" but default "x" is a string/);
    });

    it("required and default both set", () => {
      expect(() =>
        validateSchema(oneFlag({ required: true, default: "world" })),
      ).toThrow(/declares both required and default/);
    });

    it("choices on a non-string flag", () => {
      expect(() =>
        validateSchema({
          flags: { p: { type: "number", choices: ["1", "2"] as any } },
        }),
      ).toThrow(/has choices but is not a string flag/);
    });

    it("boolean default: true", () => {
      expect(() =>
        validateSchema({ flags: { v: { type: "boolean", default: true } } }),
      ).toThrow(/v1 does not support negatable booleans/);
    });

    it("short -h with non-boolean type when auto-help is active", () => {
      expect(() =>
        validateSchema({
          flags: { host: { type: "string", short: "h" } },
        }),
      ).toThrow(/uses short -h with non-boolean type; conflicts with auto-help/);
    });

    it("short -V with non-boolean type when auto-version is active", () => {
      expect(() =>
        validateSchema({
          version: "1.0",
          flags: { verbose: { type: "string", short: "V" } },
        }),
      ).toThrow(/uses short -V with non-boolean type; conflicts with auto-version/);
    });

    it("group references unknown flag", () => {
      expect(() =>
        validateSchema({
          flags: { a: { type: "boolean" } },
          groups: { exclusive: [["a", "ghost"]] },
        }),
      ).toThrow(/groups.exclusive references unknown flag --ghost/);

      expect(() =>
        validateSchema({
          flags: { a: { type: "boolean" } },
          groups: { requiredTogether: [["a", "ghost"]] },
        }),
      ).toThrow(/groups.requiredTogether references unknown flag --ghost/);
    });
  });
});

describe("normalizeSchema", () => {
  it("injects auto-help when user does not declare help", () => {
    const n = normalizeSchema({ flags: {} });
    expect(n.autoHelp).toBe(true);
    expect(n.flagsByName["help"]).toBeDefined();
    expect(n.flagsByName["help"].type).toBe("boolean");
    expect(n.flagsByShort["h"]).toBe(n.flagsByName["help"]);
  });

  it("does not inject auto-help when user declares help", () => {
    const n = normalizeSchema({
      flags: { help: { type: "boolean", short: "h" } },
    });
    expect(n.autoHelp).toBe(false);
    expect(n.flagsByName["help"].description).toBe(""); // user's, not auto's
  });

  it("injects auto-version only when schema.version is set", () => {
    const without = normalizeSchema({ flags: {} });
    expect(without.autoVersion).toBe(false);
    expect(without.flagsByName["version"]).toBeUndefined();

    const withV = normalizeSchema({ flags: {}, version: "1.0" });
    expect(withV.autoVersion).toBe(true);
    expect(withV.flagsByName["version"]).toBeDefined();
    expect(withV.flagsByShort["V"]).toBe(withV.flagsByName["version"]);
  });

  it("fills boolean default to false when not specified", () => {
    const n = normalizeSchema({
      flags: { verbose: { type: "boolean" } },
    });
    expect(n.flagsByName["verbose"].default).toBe(false);
  });

  it("preserves explicit boolean default: false", () => {
    const n = normalizeSchema({
      flags: { verbose: { type: "boolean", default: false } },
    });
    expect(n.flagsByName["verbose"].default).toBe(false);
  });

  it("leaves string/number default as null when not specified", () => {
    const n = normalizeSchema({
      flags: {
        name: { type: "string" },
        port: { type: "number" },
      },
    });
    expect(n.flagsByName["name"].default).toBeNull();
    expect(n.flagsByName["port"].default).toBeNull();
  });

  it("preserves explicit string/number defaults", () => {
    const n = normalizeSchema({
      flags: {
        name: { type: "string", default: "world" },
        port: { type: "number", default: 3000 },
      },
    });
    expect(n.flagsByName["name"].default).toBe("world");
    expect(n.flagsByName["port"].default).toBe(3000);
  });

  it("normalizes absent optionals to null/false/empty", () => {
    const n = normalizeSchema({ flags: { f: { type: "string" } } });
    const f = n.flagsByName["f"];
    expect(f.short).toBeNull();
    expect(f.choices).toBeNull();
    expect(f.required).toBe(false);
    expect(f.description).toBe("");
    expect(f.hidden).toBe(false);
  });

  it("preserves flag declaration order in flags array", () => {
    const n = normalizeSchema({
      flags: {
        zebra: { type: "string" },
        apple: { type: "number" },
        mango: { type: "boolean" },
      },
    });
    const names = n.flags.map((f) => f.name);
    expect(names.slice(0, 3)).toEqual(["zebra", "apple", "mango"]);
    expect(names).toContain("help"); // auto-injected at end
  });

  it("defaults groups to empty arrays when absent", () => {
    const n = normalizeSchema({ flags: {} });
    expect(n.groups.exclusive).toEqual([]);
    expect(n.groups.requiredTogether).toEqual([]);
  });

  it("derives programName from process.argv[1] basename when absent", () => {
    const n = normalizeSchema({ flags: {} });
    expect(typeof n.programName).toBe("string");
    expect(n.programName.length).toBeGreaterThan(0);
  });

  it("uses explicit programName when provided", () => {
    const n = normalizeSchema({ flags: {}, programName: "mytool" });
    expect(n.programName).toBe("mytool");
  });
});

describe("preScanArgv", () => {
  const schema = normalizeSchema({
    flags: {
      name: { type: "string", short: "n" },
      port: { type: "number", short: "p" },
      verbose: { type: "boolean", short: "v" },
    },
  });

  it("accepts a normal long flag with value", () => {
    expect(preScanArgv(["--name", "alice"], schema)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("accepts --flag=value", () => {
    expect(preScanArgv(["--name=alice"], schema)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("accepts -n value", () => {
    expect(preScanArgv(["-n", "alice"], schema)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("accepts -nalice (attached short value)", () => {
    expect(preScanArgv(["-nalice"], schema)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("rejects -n=value", () => {
    const result = preScanArgv(["-n=alice"], schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        kind: "shortEqualsSyntax",
        raw: "-n=alice",
        suggestion: "-n alice or -nalice",
      });
    }
  });

  it("rejects greedy --x --y for a string flag", () => {
    const result = preScanArgv(["--name", "--verbose"], schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        kind: "greedyValue",
        flag: "name",
        raw: "--verbose",
      });
    }
  });

  it("rejects greedy --x --y for a number flag", () => {
    const result = preScanArgv(["--port", "--name"], schema);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "greedyValue") {
      expect(result.error.flag).toBe("port");
    }
  });

  it("does not flag --verbose --port (verbose is boolean)", () => {
    expect(preScanArgv(["--verbose", "--port"], schema)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("honors -- end-of-options marker", () => {
    // Even -x=v after -- is accepted as a positional.
    expect(preScanArgv(["--", "-n=alice"], schema)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("accepts --name=--verbose (escape via equals)", () => {
    // The greedy rule only fires when the value is a separate token.
    expect(preScanArgv(["--name=--verbose"], schema)).toEqual({
      ok: true,
      value: undefined,
    });
  });
});

describe("callNodeParse", () => {
  const schema = normalizeSchema({
    flags: {
      name: { type: "string", short: "n" },
      port: { type: "number", short: "p" },
      verbose: { type: "boolean", short: "v" },
    },
  });

  it("parses a long flag", () => {
    const r = callNodeParse(["--name", "alice"], schema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.flags.name).toBe("alice");
  });

  it("parses --flag=value", () => {
    const r = callNodeParse(["--name=alice"], schema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.flags.name).toBe("alice");
  });

  it("parses a short alias", () => {
    const r = callNodeParse(["-n", "alice"], schema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.flags.name).toBe("alice");
  });

  it("parses a boolean flag as true when present", () => {
    const r = callNodeParse(["--verbose"], schema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.flags.verbose).toBe(true);
  });

  it("number flag comes through as a string (coerce step handles it)", () => {
    const r = callNodeParse(["--port", "3000"], schema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.flags.port).toBe("3000");
  });

  it("collects positionals", () => {
    const r = callNodeParse(["a", "--name", "alice", "b"], schema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.positionals).toEqual(["a", "b"]);
  });

  it("-- ends option parsing", () => {
    const r = callNodeParse(["--", "--name", "alice"], schema);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.flags.name).toBeUndefined();
      expect(r.value.positionals).toEqual(["--name", "alice"]);
    }
  });

  it("returns unknownLong for an unknown --flag", () => {
    const r = callNodeParse(["--ghost"], schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "unknownLong", flag: "ghost" });
  });

  it("returns unknownShort for an unknown -x", () => {
    const r = callNodeParse(["-x"], schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "unknownShort", flag: "x" });
  });

  it("returns booleanTakesNoValue for --verbose=foo", () => {
    const r = callNodeParse(["--verbose=foo"], schema);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.error).toEqual({ kind: "booleanTakesNoValue", flag: "verbose" });
  });

  it("returns missingValue for --name at end of argv", () => {
    const r = callNodeParse(["--name"], schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: "missingValue", flag: "name" });
  });

  it("clusters boolean short flags (-vp would be unknown for a non-boolean p though)", () => {
    const boolSchema = normalizeSchema({
      flags: {
        verbose: { type: "boolean", short: "v" },
        quiet: { type: "boolean", short: "q" },
      },
    });
    const r = callNodeParse(["-vq"], boolSchema);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.flags.verbose).toBe(true);
      expect(r.value.flags.quiet).toBe(true);
    }
  });
});

describe("parseStrictNumber", () => {
  it("accepts decimal integers", () => {
    expect(parseStrictNumber("0")).toBe(0);
    expect(parseStrictNumber("42")).toBe(42);
    expect(parseStrictNumber("-7")).toBe(-7);
    expect(parseStrictNumber("+7")).toBe(7);
  });

  it("accepts decimal floats and scientific notation", () => {
    expect(parseStrictNumber("3.14")).toBe(3.14);
    expect(parseStrictNumber("-1.5e3")).toBe(-1500);
  });

  it.each([
    ["", "empty"],
    ["abc", "non-numeric"],
    ["3 ", "trailing space"],
    [" 3", "leading space"],
    ["0x10", "hex"],
    ["0o10", "octal"],
    ["0b10", "binary"],
    ["NaN", "NaN"],
    ["Infinity", "infinity"],
    ["-Infinity", "negative infinity"],
  ])("rejects %s (%s)", (raw) => {
    expect(parseStrictNumber(raw)).toBeNull();
  });
});

describe("coerceValues", () => {
  const schema = normalizeSchema({
    flags: {
      name: { type: "string" },
      port: { type: "number" },
      verbose: { type: "boolean" },
      format: { type: "string", choices: ["json", "yaml"] },
    },
  });

  it("passes string values through", () => {
    const r = coerceValues({ name: "alice" }, schema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe("alice");
  });

  it("coerces number strings to numbers", () => {
    const r = coerceValues({ port: "3000" }, schema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.port).toBe(3000);
  });

  it("rejects an unparseable number", () => {
    const r = coerceValues({ port: "abc" }, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toEqual({
        kind: "invalidNumber",
        flag: "port",
        raw: "abc",
      });
    }
  });

  it("passes through booleans", () => {
    const r = coerceValues({ verbose: true }, schema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.verbose).toBe(true);
  });

  it("accepts a listed choice", () => {
    const r = coerceValues({ format: "json" }, schema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.format).toBe("json");
  });

  it("rejects an unlisted choice", () => {
    const r = coerceValues({ format: "xml" }, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toEqual({
        kind: "invalidChoice",
        flag: "format",
        raw: "xml",
        choices: ["json", "yaml"],
      });
    }
  });

  it("choices comparison is case-sensitive", () => {
    const r = coerceValues({ format: "JSON" }, schema);
    expect(r.ok).toBe(false);
  });

  it("accepts empty string for string flags (when no choices)", () => {
    const r = coerceValues({ name: "" }, schema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe("");
  });
});

describe("applyDefaults", () => {
  const schema = normalizeSchema({
    flags: {
      name: { type: "string", default: "world" },
      port: { type: "number", default: 3000 },
      verbose: { type: "boolean" }, // boolean → default: false (filled in normalize)
      out: { type: "string", required: true },
    },
  });

  it("applies defaults for absent flags", () => {
    const r = applyDefaults({}, schema);
    expect(r.ok).toBe(false); // required `out` missing
  });

  it("user value overrides default", () => {
    const r = applyDefaults({ name: "alice", out: "x" }, schema);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe("alice");
      expect(r.value.port).toBe(3000);
      expect(r.value.verbose).toBe(false);
      expect(r.value.out).toBe("x");
    }
  });

  it("returns missingRequired when a required flag has no value and no default", () => {
    const r = applyDefaults({ name: "alice" }, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toEqual({ kind: "missingRequired", flag: "out" });
    }
  });

  it("auto-injected help/version booleans get filled with false", () => {
    // The orchestrator's buildResult strips help/version from the
    // user-visible output; applyDefaults itself just fills booleans.
    const s = normalizeSchema({
      flags: { f: { type: "string", default: "x" } },
      version: "1.0",
    });
    const r = applyDefaults({}, s);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.f).toBe("x");
      expect(r.value.help).toBe(false);
      expect(r.value.version).toBe(false);
    }
  });
});

describe("checkGroups", () => {
  const schema = normalizeSchema({
    flags: {
      json: { type: "boolean" },
      yaml: { type: "boolean" },
      output: { type: "string" },
      format: { type: "string" },
    },
    groups: {
      exclusive: [["json", "yaml"]],
      requiredTogether: [["output", "format"]],
    },
  });

  it("passes when neither exclusive flag is set", () => {
    expect(checkGroups({}, schema)).toEqual({ ok: true, value: undefined });
  });

  it("passes when exactly one exclusive flag is set", () => {
    expect(checkGroups({ json: true }, schema)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("rejects when both exclusive flags are set", () => {
    const r = checkGroups({ json: true, yaml: true }, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toEqual({
        kind: "mutuallyExclusive",
        a: "json",
        b: "yaml",
      });
    }
  });

  it("passes when none of the required-together flags are set", () => {
    expect(checkGroups({}, schema)).toEqual({ ok: true, value: undefined });
  });

  it("passes when all required-together flags are set", () => {
    expect(
      checkGroups({ output: "f.txt", format: "json" }, schema),
    ).toEqual({ ok: true, value: undefined });
  });

  it("rejects when one required-together flag is set without the other", () => {
    const r = checkGroups({ output: "f.txt" }, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toEqual({
        kind: "requiredTogether",
        missing: "format",
        trigger: "output",
      });
    }
  });
});

describe("formatHelp", () => {
  it("renders the documented layout for a full schema", () => {
    const schema = normalizeSchema({
      programName: "greet",
      description: "Print a friendly greeting.",
      flags: {
        name: {
          type: "string",
          short: "n",
          default: "world",
          description: "Who to greet",
        },
        repeat: {
          type: "number",
          short: "r",
          default: 1,
          description: "How many times",
        },
        verbose: {
          type: "boolean",
          short: "v",
          description: "Chatty output",
        },
        out: {
          type: "string",
          required: true,
          description: "Output path",
        },
      },
    });
    const help = formatHelp(schema);
    expect(help).toContain("Usage: greet [options] [args...]");
    expect(help).toContain("Print a friendly greeting.");
    expect(help).toContain("-n, --name <string>");
    expect(help).toContain("Who to greet");
    expect(help).toContain('(default: "world")');
    expect(help).toContain("(default: 1)");
    expect(help).toContain("    --out <string>");
    expect(help).toContain("(required)");
    expect(help).toContain("-h, --help");
    expect(help).toContain("Show this help and exit");
    expect(help.endsWith("\n")).toBe(true);
  });

  it("omits description line when not provided", () => {
    const help = formatHelp(normalizeSchema({ programName: "x", flags: {} }));
    expect(help).not.toContain("Print a");
    expect(help).toContain("Usage: x");
  });

  it("renders choices as <a|b>", () => {
    const help = formatHelp(
      normalizeSchema({
        flags: { format: { type: "string", choices: ["json", "yaml"] } },
      }),
    );
    expect(help).toContain("--format <json|yaml>");
  });

  it("omits hidden flags", () => {
    const help = formatHelp(
      normalizeSchema({
        flags: {
          shown: { type: "string", description: "visible" },
          secret: { type: "string", hidden: true, description: "INVISIBLE" },
        },
      }),
    );
    expect(help).toContain("--shown");
    expect(help).not.toContain("--secret");
    expect(help).not.toContain("INVISIBLE");
  });

  it("renders version flag when schema.version is set", () => {
    const help = formatHelp(
      normalizeSchema({ flags: {}, version: "1.0" }),
    );
    expect(help).toContain("-V, --version");
  });

  it("renders epilog as a trailing paragraph", () => {
    const help = formatHelp(
      normalizeSchema({
        flags: {},
        epilog: "Bug reports: https://example.com",
      }),
    );
    expect(help).toMatch(/\n\nBug reports: https:\/\/example\.com\n$/);
  });

  it("does not show (default: false) for booleans", () => {
    const help = formatHelp(
      normalizeSchema({
        flags: { verbose: { type: "boolean", description: "Chatty" } },
      }),
    );
    expect(help).not.toContain("default: false");
  });

  it("renders option block with only help when flags is empty", () => {
    const help = formatHelp(normalizeSchema({ flags: {} }));
    expect(help).toContain("Options:");
    expect(help).toContain("--help");
  });
});

describe("formatError", () => {
  const schema = normalizeSchema({
    programName: "greet",
    flags: { name: { type: "string" } },
  });

  const cases: { error: ParseError; expectedMessage: string }[] = [
    { error: { kind: "unknownLong", flag: "foo" }, expectedMessage: "unknown flag --foo" },
    { error: { kind: "unknownShort", flag: "x" }, expectedMessage: "unknown short flag -x" },
    { error: { kind: "missingValue", flag: "name" }, expectedMessage: "missing value for --name" },
    {
      error: { kind: "missingRequired", flag: "out" },
      expectedMessage: "missing required flag --out",
    },
    {
      error: { kind: "invalidNumber", flag: "port", raw: "abc" },
      expectedMessage: 'invalid number for --port: "abc"',
    },
    {
      error: {
        kind: "invalidChoice",
        flag: "format",
        raw: "xml",
        choices: ["json", "yaml"],
      },
      expectedMessage:
        'invalid value for --format: "xml" (expected one of: json, yaml)',
    },
    {
      error: { kind: "booleanTakesNoValue", flag: "verbose" },
      expectedMessage: "flag --verbose does not take a value",
    },
    {
      error: { kind: "greedyValue", flag: "name", raw: "--verbose" },
      expectedMessage:
        "--name expects a value; got --verbose (use --name=--verbose to force)",
    },
    {
      error: {
        kind: "shortEqualsSyntax",
        raw: "-n=alice",
        suggestion: "-n alice or -nalice",
      },
      expectedMessage:
        'invalid short flag syntax in "-n=alice": use -n alice or -nalice',
    },
    {
      error: { kind: "duplicateFlag", flag: "name" },
      expectedMessage: "flag --name was provided more than once",
    },
    {
      error: { kind: "mutuallyExclusive", a: "json", b: "yaml" },
      expectedMessage: "--json and --yaml are mutually exclusive",
    },
    {
      error: { kind: "requiredTogether", missing: "format", trigger: "output" },
      expectedMessage: "--output requires --format",
    },
  ];

  it.each(cases)("formats $error.kind", ({ error, expectedMessage }) => {
    const out = formatError(error, schema);
    expect(out).toContain(`Error: ${expectedMessage}`);
    expect(out).toContain("Usage: greet"); // help tail printed
  });
});

describe("_parseArgsWith (end-to-end)", () => {
  const greetSchema: ArgsSchema = {
    programName: "greet",
    description: "Print a friendly greeting.",
    version: "1.2.3",
    flags: {
      name: { type: "string", short: "n", default: "world" },
      port: { type: "number", short: "p", default: 3000 },
      verbose: { type: "boolean", short: "v" },
      out: { type: "string", required: true },
    },
  };

  it("parses a successful invocation", () => {
    const { ran, result } = withMockedProcess(() =>
      _parseArgsWith(["--name", "alice", "--out", "f.txt"], greetSchema),
    );
    expect(ran).toBe(true);
    expect(result).toBeDefined();
    expect(result!.flags.name).toBe("alice");
    expect(result!.flags.port).toBe(3000);
    expect(result!.flags.verbose).toBe(false);
    expect(result!.flags.out).toBe("f.txt");
    expect(result!.positionals).toEqual([]);
  });

  it("returns a null-prototype flags object (prototype-pollution guard)", () => {
    // Use a schema that does NOT declare --__proto__ — the strict
    // parseArgs will reject unknown flags. Instead, we verify with a
    // valid schema that the returned object has no Object prototype.
    const { ran, result } = withMockedProcess(() =>
      _parseArgsWith(["--out", "f.txt"], greetSchema),
    );
    expect(ran).toBe(true);
    expect(Object.getPrototypeOf(result!.flags)).toBeNull();
  });

  it("coerces number flags", () => {
    const { ran, result } = withMockedProcess(() =>
      _parseArgsWith(["--port", "8080", "--out", "x"], greetSchema),
    );
    expect(ran).toBe(true);
    expect(result!.flags.port).toBe(8080);
  });

  it("collects positionals", () => {
    const { ran, result } = withMockedProcess(() =>
      _parseArgsWith(["--out", "x", "a", "b"], greetSchema),
    );
    expect(ran).toBe(true);
    expect(result!.positionals).toEqual(["a", "b"]);
  });

  it("--help short-circuits and exits 0 even when required flag is missing", () => {
    const { ran, capture } = withMockedProcess(() =>
      _parseArgsWith(["--help"], greetSchema),
    );
    expect(ran).toBe(false);
    expect(capture.code).toBe(0);
    expect(capture.stdout).toContain("Usage: greet");
    expect(capture.stderr).toBe("");
  });

  it("-h short alias works the same", () => {
    const { capture } = withMockedProcess(() =>
      _parseArgsWith(["-h"], greetSchema),
    );
    expect(capture.code).toBe(0);
    expect(capture.stdout).toContain("Usage: greet");
  });

  it("--version short-circuits when schema.version is set", () => {
    const { capture } = withMockedProcess(() =>
      _parseArgsWith(["--version"], greetSchema),
    );
    expect(capture.code).toBe(0);
    expect(capture.stdout).toBe("1.2.3\n");
  });

  it("--help wins even with --port bad-value also present", () => {
    const { capture } = withMockedProcess(() =>
      _parseArgsWith(["--port", "abc", "--help"], greetSchema),
    );
    expect(capture.code).toBe(0);
    expect(capture.stdout).toContain("Usage:");
  });

  it("missing required flag exits 2 with stderr message + usage", () => {
    const { capture } = withMockedProcess(() =>
      _parseArgsWith([], greetSchema),
    );
    expect(capture.code).toBe(2);
    expect(capture.stderr).toContain("missing required flag --out");
    expect(capture.stderr).toContain("Usage: greet");
    expect(capture.stdout).toBe("");
  });

  it("bad number exits 2 with strict-parse message", () => {
    const { capture } = withMockedProcess(() =>
      _parseArgsWith(["--out", "x", "--port", "abc"], greetSchema),
    );
    expect(capture.code).toBe(2);
    expect(capture.stderr).toContain('invalid number for --port: "abc"');
  });

  it("unknown flag exits 2", () => {
    const { capture } = withMockedProcess(() =>
      _parseArgsWith(["--out", "x", "--ghost"], greetSchema),
    );
    expect(capture.code).toBe(2);
    expect(capture.stderr).toContain("unknown flag --ghost");
  });

  it("prototype-pollution probe: --__proto__ x is rejected as unknown flag", () => {
    // It can't pollute Object.prototype because (a) strict: true makes
    // Node reject unknown flags, and (b) buildResult uses a
    // null-prototype object regardless. Belt and braces.
    const before = (Object.prototype as any).polluted;
    const { capture } = withMockedProcess(() =>
      _parseArgsWith(
        ["--out", "x", "--__proto__", "polluted"],
        greetSchema,
      ),
    );
    expect(capture.code).toBe(2);
    expect((Object.prototype as any).polluted).toBe(before);
  });

  it("caller-defined help flag wins; no auto-help", () => {
    const custom: ArgsSchema = {
      flags: {
        help: { type: "string", description: "help topic" },
      },
    };
    const { ran, result } = withMockedProcess(() =>
      _parseArgsWith(["--help", "syntax"], custom),
    );
    expect(ran).toBe(true);
    expect(result!.flags.help).toBe("syntax");
  });

  it("-- ends option parsing", () => {
    const { ran, result } = withMockedProcess(() =>
      _parseArgsWith(["--out", "x", "--", "--name", "alice"], greetSchema),
    );
    expect(ran).toBe(true);
    expect(result!.flags.name).toBe("world"); // default; not consumed
    expect(result!.positionals).toEqual(["--name", "alice"]);
  });

  it("mutually exclusive group", () => {
    const s: ArgsSchema = {
      flags: { a: { type: "boolean" }, b: { type: "boolean" } },
      groups: { exclusive: [["a", "b"]] },
    };
    const { capture } = withMockedProcess(() =>
      _parseArgsWith(["--a", "--b"], s),
    );
    expect(capture.code).toBe(2);
    expect(capture.stderr).toContain("--a and --b are mutually exclusive");
  });

  it("required-together group", () => {
    const s: ArgsSchema = {
      flags: { output: { type: "string" }, format: { type: "string" } },
      groups: { requiredTogether: [["output", "format"]] },
    };
    const { capture } = withMockedProcess(() =>
      _parseArgsWith(["--output", "f.txt"], s),
    );
    expect(capture.code).toBe(2);
    expect(capture.stderr).toContain("--output requires --format");
  });

  it("choices accept listed value, reject unlisted", () => {
    const s: ArgsSchema = {
      flags: { format: { type: "string", choices: ["json", "yaml"] } },
    };
    const ok = withMockedProcess(() =>
      _parseArgsWith(["--format", "json"], s),
    );
    expect(ok.ran).toBe(true);
    expect(ok.result!.flags.format).toBe("json");

    const bad = withMockedProcess(() =>
      _parseArgsWith(["--format", "xml"], s),
    );
    expect(bad.capture.code).toBe(2);
    expect(bad.capture.stderr).toContain("expected one of: json, yaml");
  });

  it("schema bug throws synchronously (before any argv touched)", () => {
    expect(() =>
      withMockedProcess(() =>
        _parseArgsWith(
          [],
          { flags: { f: { type: "boolean", default: true } } } as ArgsSchema,
        ),
      ),
    ).toThrow(/v1 does not support negatable booleans/);
  });
});
