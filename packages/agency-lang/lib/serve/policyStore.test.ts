import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PolicyStore } from "./policyStore.js";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import os from "os";

describe("PolicyStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "policy-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts with empty policy", () => {
    const store = new PolicyStore("test-server", tmpDir);
    expect(store.get()).toEqual({});
  });

  it("sets and gets a policy", () => {
    const store = new PolicyStore("test-server", tmpDir);
    const policy = {
      "email::send": [{ action: "approve" as const }],
    };
    store.set(policy);
    expect(store.get()).toEqual(policy);
  });

  it("persists policy to disk", () => {
    const policy = {
      "email::send": [{ match: { recipient: "*@co.com" }, action: "approve" as const }],
    };
    const store1 = new PolicyStore("test-server", tmpDir);
    store1.set(policy);

    // New instance should load from disk
    const store2 = new PolicyStore("test-server", tmpDir);
    expect(store2.get()).toEqual(policy);
  });

  it("clears the policy", () => {
    const store = new PolicyStore("test-server", tmpDir);
    store.set({ "x::y": [{ action: "approve" as const }] });
    store.clear();
    expect(store.get()).toEqual({});
  });

  it("clear persists to disk", () => {
    const store1 = new PolicyStore("test-server", tmpDir);
    store1.set({ "x::y": [{ action: "approve" as const }] });
    store1.clear();

    const store2 = new PolicyStore("test-server", tmpDir);
    expect(store2.get()).toEqual({});
  });

  it("rejects invalid policies", () => {
    const store = new PolicyStore("test-server", tmpDir);
    expect(() => store.set({ "x::y": [{ action: "yolo" as any }] })).toThrow();
  });

  it("writes policy file to disk", () => {
    const store = new PolicyStore("test-server", tmpDir);
    store.set({ "x::y": [{ action: "approve" as const }] });
    const filePath = path.join(tmpDir, "test-server", "policy.json");
    const content = readFileSync(filePath, "utf-8");
    expect(JSON.parse(content)).toEqual({ "x::y": [{ action: "approve" }] });
  });

  it("addRule appends a rule to an existing kind", () => {
    const store = new PolicyStore("test-server", tmpDir);
    store.addRule("email::send", { match: { recipient: "*@co.com" }, action: "approve" });
    store.addRule("email::send", { action: "reject" });
    expect(store.get()).toEqual({
      "email::send": [
        { match: { recipient: "*@co.com" }, action: "approve" },
        { action: "reject" },
      ],
    });
  });

  it("addRule creates a new kind if needed", () => {
    const store = new PolicyStore("test-server", tmpDir);
    store.addRule("shell::exec", { action: "reject" });
    expect(store.get()).toEqual({
      "shell::exec": [{ action: "reject" }],
    });
  });

  it("addRule persists to disk", () => {
    const store1 = new PolicyStore("test-server", tmpDir);
    store1.addRule("x::y", { action: "approve" });

    const store2 = new PolicyStore("test-server", tmpDir);
    expect(store2.get()).toEqual({ "x::y": [{ action: "approve" }] });
  });

  it("removeRule removes by index", () => {
    const store = new PolicyStore("test-server", tmpDir);
    store.addRule("email::send", { match: { recipient: "*@a.com" }, action: "approve" });
    store.addRule("email::send", { match: { recipient: "*@b.com" }, action: "approve" });
    store.addRule("email::send", { action: "reject" });
    store.removeRule("email::send", 1);
    expect(store.get()).toEqual({
      "email::send": [{ match: { recipient: "*@a.com" }, action: "approve" }, { action: "reject" }],
    });
  });

  it("removeRule deletes the kind when last rule is removed", () => {
    const store = new PolicyStore("test-server", tmpDir);
    store.addRule("x::y", { action: "approve" });
    store.removeRule("x::y", 0);
    expect(store.get()).toEqual({});
  });

  it("removeRule throws for invalid index", () => {
    const store = new PolicyStore("test-server", tmpDir);
    expect(() => store.removeRule("x::y", 0)).toThrow("No rule at index 0");
    store.addRule("x::y", { action: "approve" });
    expect(() => store.removeRule("x::y", 5)).toThrow("No rule at index 5");
  });

  it("removeRule throws for non-integer index", () => {
    const store = new PolicyStore("test-server", tmpDir);
    store.addRule("x::y", { action: "approve" });
    expect(() => store.removeRule("x::y", 0.5)).toThrow("Invalid index");
    expect(() => store.removeRule("x::y", NaN)).toThrow("Invalid index");
    expect(() => store.removeRule("x::y", -1)).toThrow("Invalid index");
  });

  it("addRule rejects invalid action", () => {
    const store = new PolicyStore("test-server", tmpDir);
    expect(() => store.addRule("x::y", { action: "yolo" as any })).toThrow("Invalid action");
  });

  it("addRule rejects dangerous kind names", () => {
    const store = new PolicyStore("test-server", tmpDir);
    expect(() => store.addRule("__proto__", { action: "approve" })).toThrow("Invalid kind");
    expect(() => store.addRule("constructor", { action: "approve" })).toThrow("Invalid kind");
  });

  it("addRule rejects non-string match values", () => {
    const store = new PolicyStore("test-server", tmpDir);
    expect(() => store.addRule("x::y", { action: "approve", match: { foo: 123 as any } })).toThrow(
      "match values must be strings",
    );
  });

  it("addRule enforces the rejectMessage-only-on-reject invariant", () => {
    const store = new PolicyStore("test-server", tmpDir);
    expect(() => store.addRule("x::y", { action: "approve", rejectMessage: "why" } as any)).toThrow(
      "rejectMessage",
    );
    store.addRule("x::y", { action: "reject", rejectMessage: "Use safeBash instead" });
    const reloaded = new PolicyStore("test-server", tmpDir);
    expect(reloaded.get()).toEqual({
      "x::y": [{ action: "reject", rejectMessage: "Use safeBash instead" }],
    });
  });
});

describe("PolicyStore with a broken on-disk file", () => {
  let tmpDir: string;
  let file: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "policy-broken-"));
    const dir = path.join(tmpDir, "test-server");
    mkdirSync(dir, { recursive: true });
    file = path.join(dir, "policy.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("serves an empty policy but refuses to overwrite the broken file on addRule/removeRule", () => {
    const original = JSON.stringify({
      "x::y": [{ action: "approve", rejectMessage: "stray key" }],
    });
    writeFileSync(file, original);
    const store = new PolicyStore("test-server", tmpDir);
    expect(store.get()).toEqual({});
    expect(() => store.addRule("a::b", { action: "approve" })).toThrow("failed to load");
    expect(() => store.removeRule("x::y", 0)).toThrow("failed to load");
    // The broken file is still intact for the user to fix.
    expect(readFileSync(file, "utf-8")).toBe(original);
  });

  it("set() and clear() are explicit overwrites and un-wedge the store", () => {
    writeFileSync(file, "not json at all");
    const store = new PolicyStore("test-server", tmpDir);
    store.set({ "a::b": [{ action: "approve" as const }] });
    store.addRule("c::d", { action: "reject", rejectMessage: "no" });
    const reloaded = new PolicyStore("test-server", tmpDir);
    expect(reloaded.get()).toEqual({
      "a::b": [{ action: "approve" }],
      "c::d": [{ action: "reject", rejectMessage: "no" }],
    });
  });
});
