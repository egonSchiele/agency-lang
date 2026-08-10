import { describe, it, expect, afterEach, vi } from "vitest";
import { RuntimeContext } from "../../runtime/state/context.js";
import { ThreadStore } from "../../runtime/state/threadStore.js";
import { runInTestContext } from "../../runtime/asyncContext.js";
import {
  createAwsRequestTarget,
  sendAwsRequest,
  type AwsRequest,
  type AwsRequestTarget,
} from "./client.js";
import type { AwsPartition } from "./endpoints.js";
import type { AwsCredentials } from "./credentials.js";

function makeCtx() {
  return new RuntimeContext({
    statelogConfig: {
      host: "https://example.com",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
    },
    smoltalkDefaults: {},
    dirname: process.cwd(),
  });
}

async function withCtx<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = makeCtx();
  const execCtx = await ctx.createExecutionContext({ runId: "aws-client-test" });
  return runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), fn);
}

const partition: AwsPartition = { region: "us-east-1", dnsSuffix: "amazonaws.com" };
const creds: AwsCredentials = { accessKeyId: "AKID", secretAccessKey: "SECRET" };

function getReq(target: AwsRequestTarget): AwsRequest {
  return { target, method: "GET", service: "s3", headers: {} };
}

afterEach(() => vi.restoreAllMocks());

describe("createAwsRequestTarget", () => {
  it("accepts a bare https origin and a rooted canonical URI", () => {
    const target = createAwsRequestTarget("https://b.s3.us-east-1.amazonaws.com", "/k");
    expect(target).toEqual({
      origin: "https://b.s3.us-east-1.amazonaws.com",
      canonicalUri: "/k",
    });
  });

  it.each([
    ["http://b.s3.amazonaws.com", "/k"],
    ["https://b.s3.amazonaws.com/path", "/k"],
    ["https://b.s3.amazonaws.com?x=1", "/k"],
    ["https://b.s3.amazonaws.com", "k"],
    ["https://b.s3.amazonaws.com", "/k?x=1"],
    ["https://b.s3.amazonaws.com", "/k#f"],
  ])("rejects origin=%s canonicalUri=%s", (origin, uri) => {
    expect(() => createAwsRequestTarget(origin, uri)).toThrow();
  });
});

describe("sendAwsRequest", () => {
  it("returns metadata, body bytes, and headers on success", () =>
    withCtx(async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(new Uint8Array([104, 105]), {
          status: 200,
          headers: { etag: '"abc"' },
        }),
      );
      const target = createAwsRequestTarget("https://b.s3.us-east-1.amazonaws.com", "/k");
      const res = (await sendAwsRequest(partition, creds, getReq(target))) as any;
      expect(res.ok).toBe(true);
      expect(new TextDecoder().decode(res.bytes)).toBe("hi");
      expect(res.headers.get("etag")).toBe('"abc"');
      expect(res.url).toBe("https://b.s3.us-east-1.amazonaws.com/k");
    }));

  it("preserves a non-2xx status and body for the product layer", () =>
    withCtx(async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("<Error><Code>NoSuchBucket</Code></Error>", {
          status: 404,
          statusText: "Not Found",
        }),
      );
      const target = createAwsRequestTarget("https://b.s3.us-east-1.amazonaws.com", "/k");
      const res = (await sendAwsRequest(partition, creds, getReq(target))) as any;
      expect(res.ok).toBe(false);
      expect(res.status).toBe(404);
      expect(new TextDecoder().decode(res.bytes)).toContain("NoSuchBucket");
    }));

  it("rejects a host not under the partition suffix before fetching", () =>
    withCtx(async () => {
      const spy = vi.spyOn(globalThis, "fetch");
      const target = createAwsRequestTarget("https://b.s3.evil.com", "/k");
      const res = (await sendAwsRequest(partition, creds, getReq(target))) as any;
      expect("error" in res).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    }));
});
