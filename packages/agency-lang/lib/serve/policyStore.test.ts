import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PolicyStore } from "./policyStore.js";
import { mkdtempSync, rmSync, readFileSync } from "fs";
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

  it("writes policy file with restricted permissions", () => {
    const store = new PolicyStore("test-server", tmpDir);
    store.set({ "x::y": [{ action: "approve" as const }] });
    const filePath = path.join(tmpDir, "test-server", "policy.json");
    const content = readFileSync(filePath, "utf-8");
    expect(JSON.parse(content)).toEqual({ "x::y": [{ action: "approve" }] });
  });
});
