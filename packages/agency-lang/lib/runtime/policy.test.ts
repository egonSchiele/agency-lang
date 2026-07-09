import { describe, it, expect } from "vitest";
import { checkPolicy, validatePolicy } from "./policy.js";

describe("checkPolicy", () => {
  it("returns propagate when no rules exist for the kind", () => {
    const policy = {};
    const interrupt = { effect: "std::read", message: "msg", data: { filename: "foo" }, origin: "std::fs" };
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
    expect(checkPolicy(policy, { effect: "test::greet", message: "", data: { name: "Alice" }, origin: "" }))
      .toEqual({ type: "approve" });
    expect(checkPolicy(policy, { effect: "test::greet", message: "", data: { name: "Bob" }, origin: "" }))
      .toEqual({ type: "reject" });
  });

  it("matches glob patterns with *", () => {
    const policy = {
      "test::cmd": [
        { match: { command: "ls *" }, action: "approve" as const },
        { action: "reject" as const },
      ],
    };
    expect(checkPolicy(policy, { effect: "test::cmd", message: "", data: { command: "ls -la" }, origin: "" }))
      .toEqual({ type: "approve" });
    expect(checkPolicy(policy, { effect: "test::cmd", message: "", data: { command: "rm -rf" }, origin: "" }))
      .toEqual({ type: "reject" });
  });

  it("matches glob patterns with ** for paths", () => {
    const policy = {
      "test::read": [
        { match: { path: "src/**" }, action: "approve" as const },
        { action: "reject" as const },
      ],
    };
    expect(checkPolicy(policy, { effect: "test::read", message: "", data: { path: "src/foo/bar.ts" }, origin: "" }))
      .toEqual({ type: "approve" });
    expect(checkPolicy(policy, { effect: "test::read", message: "", data: { path: "dist/foo.js" }, origin: "" }))
      .toEqual({ type: "reject" });
  });

  it("uses first-match-wins ordering", () => {
    const policy = {
      "test::greet": [
        { match: { name: "Alice" }, action: "reject" as const },
        { match: { name: "Ali*" }, action: "approve" as const },
      ],
    };
    expect(checkPolicy(policy, { effect: "test::greet", message: "", data: { name: "Alice" }, origin: "" }))
      .toEqual({ type: "reject" });
  });

  it("skips rules when match field is missing from data", () => {
    const policy = {
      "test::greet": [
        { match: { email: "alice@*" }, action: "reject" as const },
        { action: "approve" as const },
      ],
    };
    expect(checkPolicy(policy, { effect: "test::greet", message: "", data: { name: "Alice" }, origin: "" }))
      .toEqual({ type: "approve" });
  });

  it("matches on origin (special key)", () => {
    const policy = {
      "std::read": [
        { match: { origin: "std::*" }, action: "approve" as const },
        { action: "reject" as const },
      ],
    };
    expect(checkPolicy(policy, { effect: "std::read", message: "", data: {}, origin: "std::fs" }))
      .toEqual({ type: "approve" });
    expect(checkPolicy(policy, { effect: "std::read", message: "", data: {}, origin: "./myfile.agency" }))
      .toEqual({ type: "reject" });
  });

  it("matches on message (special key)", () => {
    const policy = {
      "test::x": [
        { match: { message: "Are you sure*" }, action: "approve" as const },
        { action: "reject" as const },
      ],
    };
    expect(checkPolicy(policy, { effect: "test::x", message: "Are you sure about this?", data: {}, origin: "" }))
      .toEqual({ type: "approve" });
  });

  it("ANDs all match fields together", () => {
    const policy = {
      "test::cmd": [
        { match: { command: "rm *", dir: "/tmp/*" }, action: "approve" as const },
        { action: "reject" as const },
      ],
    };
    expect(checkPolicy(policy, { effect: "test::cmd", message: "", data: { command: "rm foo", dir: "/tmp/x" }, origin: "" }))
      .toEqual({ type: "approve" });
    expect(checkPolicy(policy, { effect: "test::cmd", message: "", data: { command: "rm foo", dir: "/home/x" }, origin: "" }))
      .toEqual({ type: "reject" });
  });

  it("catch-all rule (no match) matches everything", () => {
    const policy = {
      "test::x": [{ action: "approve" as const }],
    };
    expect(checkPolicy(policy, { effect: "test::x", message: "", data: { anything: "whatever" }, origin: "" }))
      .toEqual({ type: "approve" });
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
        expect(checkPolicy(policy, { effect, message: "", data: { dir: "/etc" }, origin: "" }))
          .toEqual({ type: "approve" });
      }
    });

    it("effect-specific rules take precedence over the wildcard", () => {
      const policy = {
        "std::bash": [{ action: "reject" as const }],
        "*": [{ action: "approve" as const }],
      };
      expect(checkPolicy(policy, { effect: "std::bash", message: "", data: {}, origin: "" }))
        .toEqual({ type: "reject" });
      // An effect with no specific rule falls through to the wildcard.
      expect(checkPolicy(policy, { effect: "std::write", message: "", data: {}, origin: "" }))
        .toEqual({ type: "approve" });
    });

    it("falls back to the wildcard when a specific effect's rules all miss", () => {
      const policy = {
        "std::write": [{ match: { dir: "/app/**" }, action: "approve" as const }],
        "*": [{ action: "reject" as const }],
      };
      // Inside /app: matched by the specific rule.
      expect(checkPolicy(policy, { effect: "std::write", message: "", data: { dir: "/app/x" }, origin: "" }))
        .toEqual({ type: "approve" });
      // Outside /app: the specific rule misses, so the wildcard rejects.
      expect(checkPolicy(policy, { effect: "std::write", message: "", data: { dir: "/etc/x" }, origin: "" }))
        .toEqual({ type: "reject" });
    });

    it("still propagates when neither the effect nor the wildcard matches", () => {
      const policy = {
        "*": [{ match: { dir: "/app/**" }, action: "approve" as const }],
      };
      expect(checkPolicy(policy, { effect: "std::write", message: "", data: { dir: "/etc/x" }, origin: "" }))
        .toEqual({ type: "propagate" });
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
