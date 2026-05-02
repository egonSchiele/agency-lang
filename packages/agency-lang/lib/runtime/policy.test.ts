import { describe, it, expect } from "vitest";
import { checkPolicy, validatePolicy } from "./policy.js";

describe("checkPolicy", () => {
  it("returns propagate when no rules exist for the kind", () => {
    const policy = {};
    const interrupt = { kind: "std::read", message: "msg", data: { filename: "foo" }, origin: "std::fs" };
    const result = checkPolicy(policy, interrupt);
    expect(result).toEqual({ type: "propagate" });
  });

  it("matches exact field value (glob with no wildcards)", () => {
    const policy = {
      "test::greet": [
        { match: { name: "Alice" }, action: "allow" as const },
        { action: "deny" as const },
      ],
    };
    expect(checkPolicy(policy, { kind: "test::greet", message: "", data: { name: "Alice" }, origin: "" }))
      .toEqual({ type: "approve" });
    expect(checkPolicy(policy, { kind: "test::greet", message: "", data: { name: "Bob" }, origin: "" }))
      .toEqual({ type: "reject" });
  });

  it("matches glob patterns with *", () => {
    const policy = {
      "test::cmd": [
        { match: { command: "ls *" }, action: "allow" as const },
        { action: "deny" as const },
      ],
    };
    expect(checkPolicy(policy, { kind: "test::cmd", message: "", data: { command: "ls -la" }, origin: "" }))
      .toEqual({ type: "approve" });
    expect(checkPolicy(policy, { kind: "test::cmd", message: "", data: { command: "rm -rf" }, origin: "" }))
      .toEqual({ type: "reject" });
  });

  it("matches glob patterns with ** for paths", () => {
    const policy = {
      "test::read": [
        { match: { path: "src/**" }, action: "allow" as const },
        { action: "deny" as const },
      ],
    };
    expect(checkPolicy(policy, { kind: "test::read", message: "", data: { path: "src/foo/bar.ts" }, origin: "" }))
      .toEqual({ type: "approve" });
    expect(checkPolicy(policy, { kind: "test::read", message: "", data: { path: "dist/foo.js" }, origin: "" }))
      .toEqual({ type: "reject" });
  });

  it("uses first-match-wins ordering", () => {
    const policy = {
      "test::greet": [
        { match: { name: "Alice" }, action: "deny" as const },
        { match: { name: "Ali*" }, action: "allow" as const },
      ],
    };
    expect(checkPolicy(policy, { kind: "test::greet", message: "", data: { name: "Alice" }, origin: "" }))
      .toEqual({ type: "reject" });
  });

  it("skips rules when match field is missing from data", () => {
    const policy = {
      "test::greet": [
        { match: { email: "alice@*" }, action: "deny" as const },
        { action: "allow" as const },
      ],
    };
    expect(checkPolicy(policy, { kind: "test::greet", message: "", data: { name: "Alice" }, origin: "" }))
      .toEqual({ type: "approve" });
  });

  it("matches on origin (special key)", () => {
    const policy = {
      "std::read": [
        { match: { origin: "std::*" }, action: "allow" as const },
        { action: "deny" as const },
      ],
    };
    expect(checkPolicy(policy, { kind: "std::read", message: "", data: {}, origin: "std::fs" }))
      .toEqual({ type: "approve" });
    expect(checkPolicy(policy, { kind: "std::read", message: "", data: {}, origin: "./myfile.agency" }))
      .toEqual({ type: "reject" });
  });

  it("matches on message (special key)", () => {
    const policy = {
      "test::x": [
        { match: { message: "Are you sure*" }, action: "allow" as const },
        { action: "deny" as const },
      ],
    };
    expect(checkPolicy(policy, { kind: "test::x", message: "Are you sure about this?", data: {}, origin: "" }))
      .toEqual({ type: "approve" });
  });

  it("ANDs all match fields together", () => {
    const policy = {
      "test::cmd": [
        { match: { command: "rm *", dir: "/tmp/*" }, action: "allow" as const },
        { action: "deny" as const },
      ],
    };
    expect(checkPolicy(policy, { kind: "test::cmd", message: "", data: { command: "rm foo", dir: "/tmp/x" }, origin: "" }))
      .toEqual({ type: "approve" });
    expect(checkPolicy(policy, { kind: "test::cmd", message: "", data: { command: "rm foo", dir: "/home/x" }, origin: "" }))
      .toEqual({ type: "reject" });
  });

  it("catch-all rule (no match) matches everything", () => {
    const policy = {
      "test::x": [{ action: "allow" as const }],
    };
    expect(checkPolicy(policy, { kind: "test::x", message: "", data: { anything: "whatever" }, origin: "" }))
      .toEqual({ type: "approve" });
  });

  it("maps deny action to reject type", () => {
    const policy = {
      "test::x": [{ action: "deny" as const }],
    };
    const result = checkPolicy(policy, { kind: "test::x", message: "", data: {}, origin: "" });
    expect(result).toEqual({ type: "reject" });
  });
});

describe("validatePolicy", () => {
  it("accepts a valid policy", () => {
    const result = validatePolicy({
      "std::read": [{ match: { filename: "*.md" }, action: "allow" }],
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
