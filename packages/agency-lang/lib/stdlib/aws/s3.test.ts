import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RuntimeContext } from "../../runtime/state/context.js";
import { ThreadStore } from "../../runtime/state/threadStore.js";
import { runInTestContext, getRuntimeContext } from "../../runtime/asyncContext.js";
import { AWS_OBJECT_BYTE_LIMIT } from "../../constants.js";
import { type ResultFailure } from "../../runtime/result.js";
import { safeStatelogValue } from "../../runtime/runner.js";
import { makeRedactReplacer } from "../../runtime/redactForStatelog.js";
import {
  _s3Get,
  _s3GetBinary,
  _s3Put,
  _s3PutBinary,
  _createBucket,
  _s3PresignGet,
} from "./s3.js";

// The presign path bypasses sendAwsRequest, so nothing structural forces it
// through the final hostname defense. This partial mock lets one test inject a
// refusal and prove the executor consults the check; with no override set,
// every other test sees the real behavior.
const hostCheck = vi.hoisted(() => ({ override: null as ResultFailure | null }));
vi.mock("./client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client.js")>();
  return {
    ...actual,
    hostOutsidePartitionFailure: (
      ...args: Parameters<typeof actual.hostOutsidePartitionFailure>
    ) => hostCheck.override ?? actual.hostOutsidePartitionFailure(...args),
  };
});

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
  hostCheck.override = null;
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

  // An empty key changes the operation: GET / lists the bucket, PUT / is
  // CreateBucket. All four object helpers must reject it before any request.
  it("s3Get rejects an empty key before fetching", () =>
    withCtx(async () => {
      const spy = mockFetch();
      const result = await _s3Get("abc", "", "us-east-1");
      expect("error" in (result as object)).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    }));

  it("s3GetBinary rejects an empty key before fetching", () =>
    withCtx(async () => {
      const spy = mockFetch();
      const result = await _s3GetBinary("abc", "", "us-east-1");
      expect("error" in (result as object)).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    }));

  it("s3Put rejects an empty key before fetching", () =>
    withCtx(async () => {
      const spy = mockFetch();
      const result = await _s3Put("abc", "", "hi", "us-east-1", "text/plain");
      expect("error" in (result as object)).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    }));

  it("s3PutBinary rejects an empty key before fetching", () =>
    withCtx(async () => {
      const spy = mockFetch();
      const result = await _s3PutBinary("abc", "", "aGk=", "us-east-1", "application/octet-stream");
      expect("error" in (result as object)).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    }));
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

describe("S3 presigned URLs", () => {
  it("computes the URL locally, with all query parameters and no fetch", () =>
    withCtx(async () => {
      const spy = mockFetch();
      const url = (await _s3PresignGet("my-bucket", "a/b.txt", 3600000, "us-east-1")) as string;
      expect(url).toMatch(
        /^https:\/\/my-bucket\.s3\.us-east-1\.amazonaws\.com\/a\/b\.txt\?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKID%2F\d{8}%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=\d{8}T\d{6}Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=[0-9a-f]{64}$/,
      );
      expect(spy).not.toHaveBeenCalled();
    }));

  it("marks the returned URL redacted with the presign label", () =>
    withCtx(async () => {
      const url = await _s3PresignGet("my-bucket", "k", 3600000, "us-east-1");
      const { globals } = getRuntimeContext();
      expect(globals.redactionReplacement(url)).toBe("[presigned S3 URL redacted]");
    }));

  // The motivating use case interpolates the URL into an email body. That
  // composed string is a new value with no tag, so containment scrubbing —
  // not exact-match redaction — is what keeps the bearer URL out of traces.
  it("scrubs the URL out of composed strings at both statelog composition points", () =>
    withCtx(async () => {
      const url = (await _s3PresignGet("my-bucket", "k", 3600000, "us-east-1")) as string;
      const email = `Good morning! Today's image: ${url} — enjoy.`;
      const { globals } = getRuntimeContext();

      const posted = JSON.parse(JSON.stringify({ email }, makeRedactReplacer(globals)));
      expect(posted.email).toBe(
        "Good morning! Today's image: [presigned S3 URL redacted] — enjoy.",
      );

      const safe = safeStatelogValue(email);
      expect(safe).toBe(
        "Good morning! Today's image: [presigned S3 URL redacted] — enjoy.",
      );
    }));

  it.each([0, -5, 1.5, NaN, 604800001])(
    "rejects expiresIn=%s ms without producing a URL",
    (expires) =>
      withCtx(async () => {
        const result = await _s3PresignGet("my-bucket", "k", expires, "us-east-1");
        expect("error" in (result as object)).toBe(true);
      }),
  );

  // Boundary ms values and the seconds they sign as (sub-second rounds up).
  it.each([
    [1, 1],
    [604800000, 604800],
  ])("accepts the boundary expiry %s ms, signing %s seconds", (expiresMs, seconds) =>
    withCtx(async () => {
      const result = await _s3PresignGet("my-bucket", "k", expiresMs, "us-east-1");
      expect(typeof result).toBe("string");
      expect(result).toContain(`X-Amz-Expires=${seconds}&`);
    }));

  it("signs the session token into the query when present", () =>
    withCtx(async () => {
      process.env.AWS_SESSION_TOKEN = "TOK";
      const url = (await _s3PresignGet("my-bucket", "k", 3600000, "us-east-1")) as string;
      expect(url).toContain("&X-Amz-Security-Token=TOK&");
    }));

  it("presigns a dotted bucket path-style", () =>
    withCtx(async () => {
      const url = (await _s3PresignGet("data.exports", "k", 3600000, "eu-west-1")) as string;
      expect(url.startsWith("https://s3.eu-west-1.amazonaws.com/data.exports/k?")).toBe(true);
    }));

  it("shares the pipeline's region precedence and key rejection", () =>
    withCtx(async () => {
      process.env.AWS_REGION = "eu-west-1";
      const url = (await _s3PresignGet("my-bucket", "k", 3600000, "")) as string;
      expect(url.startsWith("https://my-bucket.s3.eu-west-1.amazonaws.com/")).toBe(true);

      const rejected = await _s3PresignGet("my-bucket", "a/../b", 3600000, "us-east-1");
      expect("error" in (rejected as object)).toBe(true);
    }));

  it("consults the final hostname defense before producing a URL", () =>
    withCtx(async () => {
      const refusal = { error: { message: "blocked by host check" } } as ResultFailure;
      hostCheck.override = refusal;
      const result = await _s3PresignGet("my-bucket", "k", 3600000, "us-east-1");
      expect(result).toBe(refusal);
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
