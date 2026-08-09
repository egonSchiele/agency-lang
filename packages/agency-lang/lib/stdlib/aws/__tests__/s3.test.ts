import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RuntimeContext } from "../../../runtime/state/context.js";
import { ThreadStore } from "../../../runtime/state/threadStore.js";
import { runInTestContext, getRuntimeContext } from "../../../runtime/asyncContext.js";
import { AWS_OBJECT_BYTE_LIMIT } from "../../objectBytes.js";
import {
  _s3Get,
  _s3GetBinary,
  _s3Put,
  _s3PutBinary,
  _createBucket,
} from "../s3.js";

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
  const execCtx = await ctx.createExecutionContext({ runId: "aws-s3-test" });
  return runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), fn);
}

function mockFetch(body: BodyInit | null = new Uint8Array(0), init: ResponseInit = { status: 200 }) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, init));
}

const ORIGINAL_ENV = process.env;
beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, AWS_ACCESS_KEY_ID: "AKID", AWS_SECRET_ACCESS_KEY: "SECRET" };
});
afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

describe("S3 addressing across partitions", () => {
  it.each([
    ["us-east-1", "https://my-bucket.s3.us-east-1.amazonaws.com/a/b.txt"],
    ["us-gov-west-1", "https://my-bucket.s3.us-gov-west-1.amazonaws.com/a/b.txt"],
    ["cn-north-1", "https://my-bucket.s3.cn-north-1.amazonaws.com.cn/a/b.txt"],
    ["us-iso-east-1", "https://my-bucket.s3.us-iso-east-1.c2s.ic.gov/a/b.txt"],
  ])("virtual-hosted URL for region %s", (region, expected) =>
    withCtx(async () => {
      const spy = mockFetch(new Uint8Array([1]));
      await _s3Get("my-bucket", "a/b.txt", region);
      expect(spy).toHaveBeenCalledWith(expected, expect.anything());
    }),
  );

  it("uses path style for a dotted bucket", () =>
    withCtx(async () => {
      const spy = mockFetch(new Uint8Array([1]));
      await _s3Get("data.exports", "k", "eu-west-1");
      expect(spy).toHaveBeenCalledWith(
        "https://s3.eu-west-1.amazonaws.com/data.exports/k",
        expect.anything(),
      );
    }));

  it("uses path style for the reserved key `soap`", () =>
    withCtx(async () => {
      const spy = mockFetch(new Uint8Array([1]));
      await _s3Get("my-bucket", "soap", "us-east-1");
      expect(spy).toHaveBeenCalledWith(
        "https://s3.us-east-1.amazonaws.com/my-bucket/soap",
        expect.anything(),
      );
    }));

  it("encodes a key once: repeated slash kept, space/percent/unicode escaped", () =>
    withCtx(async () => {
      const spy = mockFetch(new Uint8Array([1]));
      await _s3Get("abc", "a//b %雪", "us-east-1");
      expect(spy).toHaveBeenCalledWith(
        "https://abc.s3.us-east-1.amazonaws.com/a//b%20%25%E9%9B%AA",
        expect.anything(),
      );
    }));

  it("encodes a literal percent in the key", () =>
    withCtx(async () => {
      const spy = mockFetch(new Uint8Array([1]));
      await _s3Get("abc", "a%b", "us-east-1");
      expect(spy).toHaveBeenCalledWith(
        "https://abc.s3.us-east-1.amazonaws.com/a%25b",
        expect.anything(),
      );
    }));
});

describe("S3 key safety", () => {
  it.each(["a/./b", "a/../b", ".", ".."])(
    "rejects the unsafe key %s before fetching",
    (key) =>
      withCtx(async () => {
        const spy = mockFetch();
        const result = await _s3Get("abc", key, "us-east-1");
        expect(typeof result === "object" && "error" in (result as object)).toBe(true);
        expect(spy).not.toHaveBeenCalled();
      }),
  );

  it("demonstrates why: fetch would normalize `a/../b` to `/b`", () => {
    expect(new Request("https://my-bucket.s3.us-east-1.amazonaws.com/a/../b").url).toBe(
      "https://my-bucket.s3.us-east-1.amazonaws.com/b",
    );
  });
});

describe("S3 binary codecs and redaction", () => {
  it("_s3PutBinary decodes base64 to the exact bytes it sends", () =>
    withCtx(async () => {
      const spy = mockFetch(null, { status: 200 });
      await _s3PutBinary("abc", "k", "aGk=", "us-east-1", "application/octet-stream");
      const body = spy.mock.calls[0][1]!.body as Uint8Array;
      expect(Array.from(body)).toEqual([104, 105]); // "hi"
    }));

  it("_s3GetBinary base64-encodes the response and marks it redacted", () =>
    withCtx(async () => {
      mockFetch(new Uint8Array([104, 105]));
      const result = await _s3GetBinary("abc", "k", "us-east-1");
      expect(result).toBe("aGk=");
      const { globals } = getRuntimeContext();
      expect(globals.redactionReplacement(result)).toBe("[binary output truncated]");
    }));

  it("_s3PutBinary rejects malformed base64 before fetching", () =>
    withCtx(async () => {
      const spy = mockFetch();
      const result = await _s3PutBinary("abc", "k", "not*base64", "us-east-1", "application/octet-stream");
      expect("error" in (result as object)).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    }));
});

describe("S3 upload size cap", () => {
  it("rejects a text upload one byte over the limit before fetching", () =>
    withCtx(async () => {
      const spy = mockFetch();
      const result = await _s3Put(
        "abc",
        "k",
        "x".repeat(AWS_OBJECT_BYTE_LIMIT + 1),
        "us-east-1",
        "text/plain",
      );
      expect("error" in (result as object)).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    }));

  it("rejects a binary upload one byte over the limit before fetching", () =>
    withCtx(async () => {
      const spy = mockFetch();
      const oversized = Buffer.alloc(AWS_OBJECT_BYTE_LIMIT + 1).toString("base64");
      const result = await _s3PutBinary("abc", "k", oversized, "us-east-1", "application/octet-stream");
      expect("error" in (result as object)).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    }));
});

describe("S3 result metadata and errors", () => {
  it("_s3Put returns the ETag from the response header", () =>
    withCtx(async () => {
      mockFetch(null, { status: 200, headers: { etag: '"deadbeef"' } });
      const result = (await _s3Put("abc", "k", "hi", "us-east-1", "text/plain")) as any;
      expect(result.etag).toBe("deadbeef");
      expect(result.url).toBe("https://abc.s3.us-east-1.amazonaws.com/k");
    }));

  it("_createBucket returns the location header", () =>
    withCtx(async () => {
      mockFetch(null, { status: 200, headers: { location: "/abc" } });
      const result = (await _createBucket("abc", "us-east-1")) as any;
      expect(result.location).toBe("/abc");
      expect(result.region).toBe("us-east-1");
    }));

  it("maps a non-2xx S3 error body to a coded failure", () =>
    withCtx(async () => {
      mockFetch("<Error><Code>NoSuchBucket</Code><Message>nope</Message></Error>", {
        status: 404,
        statusText: "Not Found",
      });
      const result = (await _s3Get("abc", "k", "us-east-1")) as any;
      expect(result.error.status).toBe(404);
      expect(result.error.code).toBe("NoSuchBucket");
    }));
});
