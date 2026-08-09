import { signRequest } from "./sigv4.js";
import { type AwsCredentials } from "./credentials.js";
import { type AwsPartition } from "./endpoints.js";
import { runHttp, readBodyBytesCapped } from "../http.js";
import { getRuntimeContext } from "../../runtime/asyncContext.js";
import { failure, type ResultFailure } from "../../runtime/result.js";

/**
 * An atomic request target: a validated HTTPS origin and a canonical URI.
 * Transport derives the one wire URL from these, so no API ever carries an
 * independently supplied wire/signing path pair. Query-bearing operations are
 * out of scope for this S3 v1 target; add them later by extending the
 * constructor, not by exposing a raw URL.
 */
export type AwsRequestTarget = {
  readonly origin: string;
  readonly canonicalUri: string;
};

/**
 * Build a request target. Rejects an origin that is not bare `https://host`, and
 * a canonical URI that does not start with `/` or that contains query/fragment
 * delimiters.
 */
export function createAwsRequestTarget(
  origin: string,
  canonicalUri: string,
): AwsRequestTarget {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`AWS request origin is not a valid URL: ${origin}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`AWS request origin must use https: ${origin}`);
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(`AWS request origin must have no path: ${origin}`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error(`AWS request origin must have no query or fragment: ${origin}`);
  }
  if (!canonicalUri.startsWith("/")) {
    throw new Error(`AWS canonical URI must start with "/": ${canonicalUri}`);
  }
  if (canonicalUri.includes("?") || canonicalUri.includes("#")) {
    throw new Error(`AWS canonical URI must not contain "?" or "#": ${canonicalUri}`);
  }
  return { origin: url.origin, canonicalUri };
}

export type AwsRequest = {
  readonly target: AwsRequestTarget;
  readonly method: "GET" | "PUT";
  readonly service: "s3";
  readonly body?: Uint8Array | string;
  readonly headers: Readonly<Record<string, string>>;
};

export type AwsResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly bytes: Uint8Array;
  readonly headers: Headers;
};

function hostUnderSuffix(hostname: string, dnsSuffix: string): boolean {
  return hostname === dnsSuffix || hostname.endsWith(`.${dnsSuffix}`);
}

/**
 * Sign and send one AWS request. Derives the single wire URL from the target,
 * validates its hostname against the partition suffix before signing or
 * fetching, and returns metadata + body bytes for every received HTTP response
 * (the product layer interprets non-2xx). Abort/network failures propagate as
 * thrown errors via `runHttp`.
 */
export async function sendAwsRequest(
  partition: AwsPartition,
  credentials: AwsCredentials,
  request: AwsRequest,
): Promise<AwsResponse | ResultFailure> {
  const wireUrl = `${request.target.origin}${request.target.canonicalUri}`;
  const hostname = new URL(wireUrl).hostname;
  if (!hostUnderSuffix(hostname, partition.dnsSuffix)) {
    return failure({
      message: `Refusing to send: ${wireUrl} is not under ${partition.dnsSuffix}.`,
    });
  }

  const { ctx, stack } = getRuntimeContext();
  const signal = ctx.getAbortSignal(stack);
  const headers = signRequest({
    method: request.method,
    wireUrl,
    canonicalUri: request.target.canonicalUri,
    region: partition.region,
    service: request.service,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    body: request.body,
    extraHeaders: request.headers,
  });

  return runHttp(async () => {
    const response = await fetch(wireUrl, {
      method: request.method,
      headers,
      // Node's fetch accepts a Uint8Array body at runtime; the cast sidesteps
      // TS 5.x's ArrayBufferLike-vs-ArrayBuffer strictness on BufferSource.
      body:
        request.method === "GET"
          ? undefined
          : (request.body as BodyInit | undefined),
      signal,
    });
    const bytes = await readBodyBytesCapped(response, wireUrl, signal);
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: wireUrl,
      bytes,
      headers: response.headers,
    };
  }, wireUrl);
}
