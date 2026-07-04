import { describe, it, expect, vi, afterEach } from "vitest";
import { sendCallbackToParent } from "./callbackForwarding.js";

// process.send has no vi.stubEnv equivalent — save/restore it manually.
// A leaked AGENCY_IPC=1 would make later tests emit unexpectedly.
const originalSend = process.send;

afterEach(() => {
  process.send = originalSend;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("sendCallbackToParent", () => {
  it("sends a callback message when in IPC mode", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const sent: any[] = [];
    process.send = ((m: any) => { sent.push(m); return true; }) as any;
    sendCallbackToParent("onNodeStart", { nodeName: "n" });
    expect(sent).toEqual([{ type: "callback", name: "onNodeStart", data: { nodeName: "n" } }]);
  });

  it("no-ops outside IPC mode", () => {
    const send = vi.fn(() => true);
    process.send = send as any;
    sendCallbackToParent("onNodeStart", { nodeName: "n" });
    expect(send).not.toHaveBeenCalled();
  });

  it("no-ops when process.send is unavailable", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    (process as any).send = undefined;
    expect(() => sendCallbackToParent("onNodeStart", { nodeName: "n" })).not.toThrow();
  });

  it("strips function-valued fields (e.g. onAgentStart.cancel) on the wire", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const sent: any[] = [];
    // Emulate the real fork's default ("json") IPC serialization: process.send
    // JSON-serializes internally, which is what strips function fields. The
    // sender hands off the object directly (no redundant parse round-trip), so
    // the mock must serialize to reflect the actual wire payload.
    process.send = ((m: any) => { sent.push(JSON.parse(JSON.stringify(m))); return true; }) as any;
    sendCallbackToParent("onAgentStart", { nodeName: "n", args: {}, messages: [], cancel: () => {} });
    expect(sent).toEqual([
      { type: "callback", name: "onAgentStart", data: { nodeName: "n", args: {}, messages: [] } },
    ]);
  });

  it("drops an oversize payload instead of sending", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const send = vi.fn(() => true);
    process.send = send as any;
    sendCallbackToParent("onNodeStart", { nodeName: "x".repeat(100) }, 10);
    expect(send).not.toHaveBeenCalled();
  });

  it("drops an unserializable payload instead of throwing", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const send = vi.fn(() => true);
    process.send = send as any;
    const circular: any = {};
    circular.self = circular;
    expect(() => sendCallbackToParent("onNodeStart", circular)).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("swallows a dead-channel send error", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    process.send = vi.fn(() => { throw new Error("channel closed"); }) as any;
    expect(() => sendCallbackToParent("onNodeStart", { nodeName: "n" })).not.toThrow();
  });

  it("does not forward a denylisted callback (onStream)", () => {
    vi.stubEnv("AGENCY_IPC", "1");
    const send = vi.fn(() => true);
    process.send = send as any;
    sendCallbackToParent("onStream", { type: "text", text: "hi" } as any);
    sendCallbackToParent("onOAuthRequired", { serverName: "s", authUrl: "u" } as any);
    expect(send).not.toHaveBeenCalled();
  });
});
