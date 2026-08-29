import { describe, it, expect, vi } from "vitest";
import {
  checkPolicy,
  resolveDotDirPattern,
  expandAgencyInstallDir,
  validatePolicy,
  escapeGlob,
} from "./policy.js";
import { getStdlibDir } from "../importPaths.js";
import path from "path";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from "fs";
import { tmpdir } from "os";
import picomatch from "picomatch";

describe("checkPolicy", () => {
  it("returns propagate when no rules exist for the kind", () => {
    const policy = {};
    const interrupt = {
      effect: "std::read",
      message: "msg",
      data: { filename: "foo" },
      origin: "std::fs",
    };
    const result = checkPolicy(policy, interrupt);
    expect(result).toEqual({ type: "propagate" });
  });

  it("matches exact field value (glob with no wildcards)", () => {
    const policy = {
      "test::greet": [
        { match: { name: "Alice" }, action: "approve" as const },
        { action: "reject" as const },
      ],
    };
    expect(
      checkPolicy(policy, {
        effect: "test::greet",
        message: "",
        data: { name: "Alice" },
        origin: "",
      }),
    ).toEqual({ type: "approve" });
    expect(
      checkPolicy(policy, {
        effect: "test::greet",
        message: "",
        data: { name: "Bob" },
        origin: "",
      }),
    ).toEqual({ type: "reject" });
  });

  it("matches glob patterns with *", () => {
    const policy = {
      "test::cmd": [
        { match: { command: "ls *" }, action: "approve" as const },
        { action: "reject" as const },
      ],
    };
    expect(
      checkPolicy(policy, {
        effect: "test::cmd",
        message: "",
        data: { command: "ls -la" },
        origin: "",
      }),
    ).toEqual({ type: "approve" });
    expect(
      checkPolicy(policy, {
        effect: "test::cmd",
        message: "",
        data: { command: "rm -rf" },
        origin: "",
      }),
    ).toEqual({ type: "reject" });
  });

  it("matches glob patterns with ** for paths", () => {
    const policy = {
      "test::read": [
        { match: { path: "src/**" }, action: "approve" as const },
        { action: "reject" as const },
      ],
    };
    expect(
      checkPolicy(policy, {
        effect: "test::read",
        message: "",
        data: { path: "src/foo/bar.ts" },
        origin: "",
      }),
    ).toEqual({ type: "approve" });
    expect(
      checkPolicy(policy, {
        effect: "test::read",
        message: "",
        data: { path: "dist/foo.js" },
        origin: "",
      }),
    ).toEqual({ type: "reject" });
  });

  it("uses first-match-wins ordering", () => {
    const policy = {
      "test::greet": [
        { match: { name: "Alice" }, action: "reject" as const },
        { match: { name: "Ali*" }, action: "approve" as const },
      ],
    };
    expect(
      checkPolicy(policy, {
        effect: "test::greet",
        message: "",
        data: { name: "Alice" },
        origin: "",
      }),
    ).toEqual({ type: "reject" });
  });

  it("skips rules when match field is missing from data", () => {
    const policy = {
      "test::greet": [
        { match: { email: "alice@*" }, action: "reject" as const },
        { action: "approve" as const },
      ],
    };
    expect(
      checkPolicy(policy, {
        effect: "test::greet",
        message: "",
        data: { name: "Alice" },
        origin: "",
      }),
    ).toEqual({ type: "approve" });
  });

  it("matches on origin (special key)", () => {
    const policy = {
      "std::read": [
        { match: { origin: "std::*" }, action: "approve" as const },
        { action: "reject" as const },
      ],
    };
    expect(
      checkPolicy(policy, { effect: "std::read", message: "", data: {}, origin: "std::fs" }),
    ).toEqual({ type: "approve" });
    expect(
      checkPolicy(policy, {
        effect: "std::read",
        message: "",
        data: {},
        origin: "./myfile.agency",
      }),
    ).toEqual({ type: "reject" });
  });

  it("matches on message (special key)", () => {
    const policy = {
      "test::x": [
        { match: { message: "Are you sure*" }, action: "approve" as const },
        { action: "reject" as const },
      ],
    };
    expect(
      checkPolicy(policy, {
        effect: "test::x",
        message: "Are you sure about this?",
        data: {},
        origin: "",
      }),
    ).toEqual({ type: "approve" });
  });

  it("ANDs all match fields together", () => {
    const policy = {
      "test::cmd": [
        { match: { command: "rm *", dir: "/tmp/*" }, action: "approve" as const },
        { action: "reject" as const },
      ],
    };
    expect(
      checkPolicy(policy, {
        effect: "test::cmd",
        message: "",
        data: { command: "rm foo", dir: "/tmp/x" },
        origin: "",
      }),
    ).toEqual({ type: "approve" });
    expect(
      checkPolicy(policy, {
        effect: "test::cmd",
        message: "",
        data: { command: "rm foo", dir: "/home/x" },
        origin: "",
      }),
    ).toEqual({ type: "reject" });
  });

  it("catch-all rule (no match) matches everything", () => {
    const policy = {
      "test::x": [{ action: "approve" as const }],
    };
    expect(
      checkPolicy(policy, {
        effect: "test::x",
        message: "",
        data: { anything: "whatever" },
        origin: "",
      }),
    ).toEqual({ type: "approve" });
  });

  it("reject action produces reject result", () => {
    const policy = {
      "test::x": [{ action: "reject" as const }],
    };
    const result = checkPolicy(policy, { effect: "test::x", message: "", data: {}, origin: "" });
    expect(result).toEqual({ type: "reject" });
  });

  describe('"*" wildcard catch-all', () => {
    it("approve-all: applies to every effect, including unlisted ones", () => {
      const policy = { "*": [{ action: "approve" as const }] };
      for (const effect of ["std::write", "std::bash", "std::remove", "anything::else"]) {
        expect(
          checkPolicy(policy, { effect, message: "", data: { dir: "/etc" }, origin: "" }),
        ).toEqual({ type: "approve" });
      }
    });

    it("effect-specific rules take precedence over the wildcard", () => {
      const policy = {
        "std::bash": [{ action: "reject" as const }],
        "*": [{ action: "approve" as const }],
      };
      expect(
        checkPolicy(policy, { effect: "std::bash", message: "", data: {}, origin: "" }),
      ).toEqual({ type: "reject" });
      // An effect with no specific rule falls through to the wildcard.
      expect(
        checkPolicy(policy, { effect: "std::write", message: "", data: {}, origin: "" }),
      ).toEqual({ type: "approve" });
    });

    it("falls back to the wildcard when a specific effect's rules all miss", () => {
      const policy = {
        "std::write": [{ match: { dir: "/app/**" }, action: "approve" as const }],
        "*": [{ action: "reject" as const }],
      };
      // Inside /app: matched by the specific rule.
      expect(
        checkPolicy(policy, {
          effect: "std::write",
          message: "",
          data: { dir: "/app/x" },
          origin: "",
        }),
      ).toEqual({ type: "approve" });
      // Outside /app: the specific rule misses, so the wildcard rejects.
      expect(
        checkPolicy(policy, {
          effect: "std::write",
          message: "",
          data: { dir: "/etc/x" },
          origin: "",
        }),
      ).toEqual({ type: "reject" });
    });

    it("still propagates when neither the effect nor the wildcard matches", () => {
      const policy = {
        "*": [{ match: { dir: "/app/**" }, action: "approve" as const }],
      };
      expect(
        checkPolicy(policy, {
          effect: "std::write",
          message: "",
          data: { dir: "/etc/x" },
          origin: "",
        }),
      ).toEqual({ type: "propagate" });
    });
  });

  describe("./ prefix normalization (picomatch workaround)", () => {
    // picomatch.isMatch returns false for patterns starting with `./`
    // when combined with `**` or brace expansions — e.g.
    //   isMatch("./docs/guide",      "./docs/guide{,/**}") === false
    //   isMatch("./docs/guide/x.md", "./docs/guide{,/**}") === false
    // Stripping a leading `./` from both value and pattern normalizes
    // the path so the match succeeds. These tests pin the desired
    // behavior so we notice if picomatch ever changes (and the
    // workaround can be removed).
    it("matches ./path against ./path{,/**} pattern (scoped approve)", () => {
      const policy = {
        "std::read": [
          { match: { dir: "./docs/guide{,/**}" }, action: "approve" as const },
          { action: "reject" as const },
        ],
      };
      expect(
        checkPolicy(policy, {
          effect: "std::read",
          message: "",
          data: { dir: "./docs/guide" },
          origin: "",
        }),
      ).toEqual({ type: "approve" });
    });

    it("matches ./path/sub against ./path{,/**} pattern", () => {
      const policy = {
        "std::read": [
          { match: { dir: "./docs/guide{,/**}" }, action: "approve" as const },
          { action: "reject" as const },
        ],
      };
      expect(
        checkPolicy(policy, {
          effect: "std::read",
          message: "",
          data: { dir: "./docs/guide/sub" },
          origin: "",
        }),
      ).toEqual({ type: "approve" });
    });

    it("matches bare path against ./path pattern (asymmetric ./)", () => {
      const policy = {
        "std::read": [
          { match: { dir: "./docs" }, action: "approve" as const },
          { action: "reject" as const },
        ],
      };
      expect(
        checkPolicy(policy, {
          effect: "std::read",
          message: "",
          data: { dir: "docs" },
          origin: "",
        }),
      ).toEqual({ type: "approve" });
    });

    it("does NOT match sibling dirs with shared prefix", () => {
      // Regression guard: stripping `./` should NOT make `./docs/guide`
      // match `./docs/guidance{,/**}` or vice versa.
      const policy = {
        "std::read": [
          { match: { dir: "./docs/guide{,/**}" }, action: "approve" as const },
          { action: "reject" as const },
        ],
      };
      expect(
        checkPolicy(policy, {
          effect: "std::read",
          message: "",
          data: { dir: "./docs/guidance" },
          origin: "",
        }),
      ).toEqual({ type: "reject" });
    });

    it("does NOT match unrelated paths", () => {
      const policy = {
        "std::read": [
          { match: { dir: "./docs/guide{,/**}" }, action: "approve" as const },
          { action: "reject" as const },
        ],
      };
      expect(
        checkPolicy(policy, {
          effect: "std::read",
          message: "",
          data: { dir: "./src" },
          origin: "",
        }),
      ).toEqual({ type: "reject" });
    });

    it("absolute paths still work (no ./ to strip)", () => {
      const policy = {
        "std::read": [
          { match: { dir: "/abs/path{,/**}" }, action: "approve" as const },
          { action: "reject" as const },
        ],
      };
      expect(
        checkPolicy(policy, {
          effect: "std::read",
          message: "",
          data: { dir: "/abs/path/x" },
          origin: "",
        }),
      ).toEqual({ type: "approve" });
    });
  });
});

describe("validatePolicy", () => {
  it("accepts a valid policy", () => {
    const result = validatePolicy({
      "std::read": [{ match: { filename: "*.md" }, action: "approve" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid action strings", () => {
    const result = validatePolicy({
      "std::read": [{ action: "yolo" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-array rule values", () => {
    const result = validatePolicy({
      "std::read": "allow",
    });
    expect(result.success).toBe(false);
  });
});

describe("checkPolicy for mcp::call", () => {
  const intr = (data: any) => ({
    effect: "mcp::call",
    message: "m",
    data,
    origin: "o",
  });

  it("matches on server and on server+tool; args is not matchable", () => {
    const rejectGithub = {
      "mcp::call": [{ match: { server: "github" }, action: "reject" as const }],
    };
    expect(checkPolicy(rejectGithub, intr({ server: "github", tool: "x", args: {} })).type).toBe(
      "reject",
    );

    const approveRead = {
      "mcp::call": [{ match: { server: "fs", tool: "read_file" }, action: "approve" as const }],
    };
    expect(
      checkPolicy(approveRead, intr({ server: "fs", tool: "read_file", args: { path: "/a" } }))
        .type,
    ).toBe("approve");

    // A rule that tries to match on args does NOT match (nested object) → propagate.
    const argsRule = {
      "mcp::call": [{ match: { args: "anything" }, action: "approve" as const }],
    };
    expect(
      checkPolicy(argsRule, intr({ server: "fs", tool: "read_file", args: { path: "/a" } })).type,
    ).toBe("propagate");
  });
});

describe("dot dir patterns", () => {
  const write = (dir: string) => ({
    effect: "std::write",
    message: "m",
    data: { dir, filename: "out.txt" },
    origin: "std::fs",
  });

  it("`.` in a dir pattern means the launch directory", () => {
    const policy = {
      "std::write": [{ match: { dir: "." }, action: "approve" as const }],
    };
    expect(checkPolicy(policy, write(process.cwd())).type).toBe("approve");
    expect(checkPolicy(policy, write("/somewhere/else")).type).toBe("propagate");
  });

  it("resolves `.` inside brace alternatives and path prefixes", () => {
    const policy = {
      "std::write": [{ match: { dir: "{.,./**}" }, action: "approve" as const }],
    };
    expect(checkPolicy(policy, write(process.cwd())).type).toBe("approve");
    expect(checkPolicy(policy, write(process.cwd() + "/sub/deeper")).type).toBe("approve");
    expect(checkPolicy(policy, write("/somewhere/else")).type).toBe("propagate");
  });

  // Not asserted: dot-led subdirectories BELOW the launch dir (`cwd/.x/...`)
  // stay unmatched — picomatch's `**` never matches dot segments. A launch
  // dir whose own path contains dot segments is fine (literal prefix).

  it("does not resolve `.` in non-dir fields", () => {
    const policy = {
      "std::exec": [{ match: { command: "./run.sh" }, action: "approve" as const }],
    };
    const intr = {
      effect: "std::exec",
      message: "m",
      data: { command: "./run.sh" },
      origin: "std::shell",
    };
    // stripDotSlash normalizes both sides, so the literal pattern still matches raw.
    expect(checkPolicy(policy, intr).type).toBe("approve");
  });
});

describe("<agency> dir patterns", () => {
  const read = (dir: string) => ({
    effect: "std::read",
    message: "m",
    data: { dir, filename: "x" },
    origin: "std::fs",
  });
  const policy = {
    "std::read": [
      { match: { dir: "{<agency>/stdlib/**,<agency>/dist/**}" }, action: "approve" as const },
    ],
  };

  it("`<agency>` means the install root, resolved at match time", () => {
    const stdlib = getStdlibDir();
    expect(checkPolicy(policy, read(path.join(stdlib, "docs", "guide"))).type).toBe("approve");
    expect(checkPolicy(policy, read(path.join(stdlib, "agents", "skills", "verifier"))).type).toBe(
      "approve",
    );
    expect(
      checkPolicy(policy, read(path.join(path.dirname(stdlib), "dist", "lib", "agents"))).type,
    ).toBe("approve");
    // The package root itself, its parent, and a home directory: not covered.
    expect(checkPolicy(policy, read(path.dirname(stdlib))).type).toBe("propagate");
    expect(checkPolicy(policy, read(path.dirname(path.dirname(stdlib)))).type).toBe("propagate");
    expect(checkPolicy(policy, read("/Users/someone")).type).toBe("propagate");
  });

  it("escapes the root so glob characters in the install path stay literal", () => {
    expect(expandAgencyInstallDir("<agency>/stdlib/**", () => "/opt/v*1")).toBe(
      "/opt/v\\*1/stdlib/**",
    );
  });

  it("leaves the token unresolved, and nothing thrown, when the root cannot be found", () => {
    const unresolvable = () => {
      throw new Error("no package.json");
    };
    expect(expandAgencyInstallDir("<agency>/stdlib/**", unresolvable)).toBe("<agency>/stdlib/**");
    expect(expandAgencyInstallDir("/plain/**", unresolvable)).toBe("/plain/**");
  });
});

describe("resolveDotDirPattern escaping", () => {
  it("treats glob characters in the launch path as literal", () => {
    const resolved = resolveDotDirPattern("{.,./**}", "/tmp/cwd*");
    expect(picomatch.isMatch("/tmp/cwd*", resolved)).toBe(true);
    expect(picomatch.isMatch("/tmp/cwd*/sub/deep", resolved)).toBe(true);
    // Without escaping, the `*` in the path would approve this sibling.
    expect(picomatch.isMatch("/tmp/cwd-neighbor", resolved)).toBe(false);
  });

  it("escapes brackets and braces in the launch path", () => {
    const resolved = resolveDotDirPattern("./**", "/tmp/v[1]{a,b}");
    expect(picomatch.isMatch("/tmp/v[1]{a,b}/x", resolved)).toBe(true);
    expect(picomatch.isMatch("/tmp/v1a/x", resolved)).toBe(false);
  });

  it("inserts a cwd containing replacement-string metacharacters literally", () => {
    const resolved = resolveDotDirPattern("./**", "/tmp/a$&b");
    expect(picomatch.isMatch("/tmp/a$&b/x", resolved)).toBe(true);
    expect(picomatch.isMatch("/tmp/a.b/x", resolved)).toBe(false);
  });

  it("keeps glob syntax live in the user-written suffix", () => {
    const resolved = resolveDotDirPattern("./sub/**", "/tmp/plain");
    expect(picomatch.isMatch("/tmp/plain/sub/a/b", resolved)).toBe(true);
    expect(picomatch.isMatch("/tmp/plain/other", resolved)).toBe(false);
  });
});

describe("dot expansion canonicalizes the launch directory", () => {
  it("a symlinked cwd resolves to its real directory in the pattern", () => {
    const base = mkdtempSync(path.join(tmpdir(), "policy-dot-"));
    try {
      const real = path.join(base, "real");
      mkdirSync(real);
      const link = path.join(base, "link");
      symlinkSync(real, link);
      const resolved = resolveDotDirPattern("{.,./**}", link);
      const realRoot = realpathSync(real);
      expect(picomatch.isMatch(realRoot, resolved)).toBe(true);
      expect(picomatch.isMatch(path.join(realRoot, "sub", "deep"), resolved)).toBe(true);
      expect(picomatch.isMatch(path.join(base, "outside"), resolved)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("is wired through checkPolicy, not only the resolver", () => {
    const base = mkdtempSync(path.join(tmpdir(), "policy-dot-"));
    const cwdSpy = vi.spyOn(process, "cwd");
    try {
      const real = path.join(base, "real");
      mkdirSync(real);
      const link = path.join(base, "link");
      symlinkSync(real, link);
      cwdSpy.mockReturnValue(link);
      const policy = { "std::write": [{ match: { dir: "{.,./**}" }, action: "approve" as const }] };
      const intr = (dir: string) => ({
        effect: "std::write",
        message: "",
        data: { dir, filename: "x.txt" },
        origin: "",
      });
      expect(checkPolicy(policy, intr(realpathSync(real))).type).toBe("approve");
      expect(checkPolicy(policy, intr(path.join(base, "outside"))).type).toBe("propagate");
    } finally {
      cwdSpy.mockRestore();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("keeps the lexical cwd when realpath fails, with escaping intact", () => {
    const resolved = resolveDotDirPattern("./**", "/nonexistent-policy-cwd*");
    expect(picomatch.isMatch("/nonexistent-policy-cwd*/x", resolved)).toBe(true);
    expect(picomatch.isMatch("/nonexistent-policy-cwdX/x", resolved)).toBe(false);
  });
});

describe("escapeGlob", () => {
  const intr = (effect: string, data: Record<string, string>) => ({
    effect,
    message: "",
    data,
    origin: "test",
  });

  it("makes a literal value match only itself", () => {
    const policy = {
      "std::bash": [{ match: { command: escapeGlob("ls *.md") }, action: "approve" as const }],
    };
    expect(checkPolicy(policy, intr("std::bash", { command: "ls *.md" })).type).toBe("approve");
    expect(checkPolicy(policy, intr("std::bash", { command: "ls a.md" })).type).not.toBe(
      "approve",
    );
  });

  it("keeps a brace-expanded subpath scope working around an escaped base", () => {
    const base = escapeGlob("/tmp/[x]");
    const policy = {
      "std::read": [{ match: { dir: `{${base},${base}/**}` }, action: "approve" as const }],
    };
    expect(checkPolicy(policy, intr("std::read", { dir: "/tmp/[x]/sub" })).type).toBe("approve");
    expect(checkPolicy(policy, intr("std::read", { dir: "/tmp/x/sub" })).type).not.toBe(
      "approve",
    );
  });
});
