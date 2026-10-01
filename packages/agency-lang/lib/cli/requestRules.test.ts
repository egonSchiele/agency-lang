import { describe, it, expect } from "vitest";
import { applyRequestRules, anyPart, type RequestRules } from "./requestRules.js";

const rules: RequestRules = {
  routes: [{ method: "POST", path: "/chat" }],
  parts: { text: anyPart, rejected: () => "Rejected by part check." },
  moved: [
    { from: "old", to: "new" },
    { from: "settings.enabled", to: "enabled" },
  ],
  refused: ["settings", "limit"],
};
const apply = (body: Record<string, unknown>, path = "/chat") =>
  applyRequestRules(rules, { method: "POST", path, body });

describe("request rules", () => {
  it("accepts an allowed route without messages", () => {
    expect(apply({ model: "a" })).toEqual({ body: { model: "a" } });
  });
  it("refuses another route", () => {
    expect(apply({}, "/other")).toMatchObject({ refusal: { status: 404 } });
  });
  it("accepts a listed part", () => {
    const body = { messages: [{ content: [{ type: "text", text: "hello" }] }] };
    expect(apply(body)).toEqual({ body });
  });
  it.each(["unknown", "rejected"])("refuses part %s", (type) => {
    expect(apply({ messages: [{ content: [{ type }] }] })).toMatchObject({
      refusal: { status: 400 },
    });
  });
  it("moves a top-level field", () => {
    expect(apply({ old: 0 })).toEqual({ body: { new: 0 } });
  });
  it("moves a nested field without mutating the original", () => {
    const body = { settings: { enabled: false } };
    expect(apply(body)).toEqual({ body: { enabled: false } });
    expect(body).toEqual({ settings: { enabled: false } });
  });
  it("refuses remaining nested fields", () => {
    expect(apply({ settings: { enabled: true, unknown: 1 } })).toMatchObject({
      refusal: { status: 400 },
    });
  });
  it("refuses an unsupported field even when false", () => {
    expect(apply({ limit: false })).toMatchObject({ refusal: { status: 400 } });
  });
  it("refuses conflicting aliases", () => {
    expect(apply({ old: 1, new: 2 })).toMatchObject({ refusal: { status: 400 } });
  });
  it.each([42, {}, [null], [{ content: {} }], [{ content: [null] }]])(
    "refuses malformed messages %j",
    (messages) => {
      expect(apply({ messages })).toMatchObject({ refusal: { status: 400 } });
    },
  );
});
