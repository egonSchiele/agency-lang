import { failure, type ResultFailure } from "../../runtime/result.js";
import { getRuntimeContext } from "../../runtime/asyncContext.js";
import { decodeBase64Strict } from "../base64.js";
import { objectSizeFailure } from "../objectBytes.js";
import { awsUriEncode } from "./uri.js";
import { resolveAwsCredentials, resolveRegion } from "./credentials.js";
import {
  resolveAwsPartition,
  validateBucket,
  type AwsPartition,
  type ValidatedBucket,
} from "./endpoints.js";
import {
  createAwsRequestTarget,
  sendAwsRequest,
  hostOutsidePartitionFailure,
  type AwsRequestTarget,
  type AwsResponse,
} from "./client.js";
import { presignRequest } from "./sigv4.js";
import { s3ErrorToFailure } from "./errors.js";

const BINARY_MARKER = "[binary output truncated]";
// A presigned URL is a bearer credential; it must never land in a trace.
const PRESIGN_MARKER = "[presigned S3 URL redacted]";
const MAX_PRESIGN_SECONDS = 604800; // 7 days, the SigV4 maximum

export type GetTextOperation = {
  readonly kind: "getText";
  readonly bucket: string;
  readonly key: string;
};

export type GetBinaryOperation = {
  readonly kind: "getBinary";
  readonly bucket: string;
  readonly key: string;
};

export type PutTextOperation = {
  readonly kind: "putText";
  readonly bucket: string;
  readonly key: string;
  readonly content: string;
  readonly contentType: string;
};

export type PutBinaryOperation = {
  readonly kind: "putBinary";
  readonly bucket: string;
  readonly key: string;
  readonly base64: string;
  readonly contentType: string;
};

export type CreateBucketOperation = {
  readonly kind: "createBucket";
  readonly bucket: string;
};

export type PresignGetOperation = {
  readonly kind: "presignGet";
  readonly bucket: string;
  readonly key: string;
  readonly expiresInSeconds: number;
};

export type S3Operation =
  | GetTextOperation
  | GetBinaryOperation
  | PutTextOperation
  | PutBinaryOperation
  | CreateBucketOperation
  | PresignGetOperation;

export type S3PutResult = {
  readonly bucket: string;
  readonly key: string;
  readonly url: string;
  readonly etag: string;
};

export type S3CreateBucketResult = {
  readonly bucket: string;
  readonly region: string;
  readonly location: string;
};

export type S3OperationResult =
  | string
  | S3PutResult
  | S3CreateBucketResult
  | ResultFailure;

// A key must not contain a complete "." or ".." slash-delimited segment: v1
// `fetch` normalizes those away, so the signed path and the fetched path would
// diverge. Reject them before endpoint construction.
function keyFailure(key: string): ResultFailure | null {
  // An empty key changes the operation entirely: GET / lists the bucket and
  // PUT / creates the bucket (which for an already-owned us-east-1 bucket can
  // return 200 and reset ACLs) — under an object-read/write approval. Reject it.
  if (key.length === 0) {
    return failure({
      message: "Invalid S3 key: an empty key is not allowed for an object operation.",
    });
  }
  for (const segment of key.split("/")) {
    if (segment === "." || segment === "..") {
      return failure({
        message: `Invalid S3 key ${JSON.stringify(key)}: "." and ".." segments are not allowed.`,
      });
    }
  }
  return null;
}

// No silent clamping: a caller who asked for 30 days must get an error, not a
// 7-day link.
function expiresFailure(expiresInSeconds: number): ResultFailure | null {
  if (
    !Number.isInteger(expiresInSeconds) ||
    expiresInSeconds < 1 ||
    expiresInSeconds > MAX_PRESIGN_SECONDS
  ) {
    return failure({
      message:
        `Invalid expiresInSeconds ${JSON.stringify(expiresInSeconds)}: must be ` +
        `an integer between 1 and ${MAX_PRESIGN_SECONDS} (7 days).`,
    });
  }
  return null;
}

// The reserved object key `soap` cannot be served virtual-hosted style.
function keyForcesPathStyle(key: string): boolean {
  return key === "soap";
}

function virtualHostedOrigin(partition: AwsPartition, bucket: ValidatedBucket): string {
  return `https://${bucket.name}.s3.${partition.region}.${partition.dnsSuffix}`;
}

function pathStyleOrigin(partition: AwsPartition): string {
  return `https://s3.${partition.region}.${partition.dnsSuffix}`;
}

function createObjectTarget(
  partition: AwsPartition,
  bucket: ValidatedBucket,
  key: string,
): AwsRequestTarget {
  const encodedKey = awsUriEncode(key, false);
  const usePathStyle = bucket.addressing === "pathStyle" || keyForcesPathStyle(key);
  if (usePathStyle) {
    return createAwsRequestTarget(pathStyleOrigin(partition), `/${bucket.name}/${encodedKey}`);
  }
  return createAwsRequestTarget(virtualHostedOrigin(partition, bucket), `/${encodedKey}`);
}

function createBucketTarget(
  partition: AwsPartition,
  bucket: ValidatedBucket,
): AwsRequestTarget {
  if (bucket.addressing === "pathStyle") {
    return createAwsRequestTarget(pathStyleOrigin(partition), `/${bucket.name}`);
  }
  return createAwsRequestTarget(virtualHostedOrigin(partition, bucket), "/");
}

// A non-2xx S3 response becomes a coded failure; a 2xx response is passed through.
function responseErrorOrNull(response: AwsResponse): ResultFailure | null {
  if (response.ok) return null;
  return s3ErrorToFailure(
    response.status,
    response.statusText,
    response.url,
    new TextDecoder("utf-8").decode(response.bytes),
  );
}

/**
 * The one place that owns the full imperative pipeline for every S3 operation:
 * validation, credential/partition/bucket resolution, key checks, target
 * construction, codecs, the upload cap, transport, non-2xx mapping, binary
 * redaction, and result shaping. The extern helpers below are one-call adapters.
 */
export async function runS3Operation(
  region: string,
  operation: S3Operation,
): Promise<S3OperationResult> {
  const credentials = resolveAwsCredentials();
  if ("error" in credentials) return credentials;
  const partition = resolveAwsPartition(resolveRegion(region));
  if ("error" in partition) return partition;
  const bucket = validateBucket(operation.bucket);
  if ("error" in bucket) return bucket;

  switch (operation.kind) {
    case "getText":
    case "getBinary": {
      const keyError = keyFailure(operation.key);
      if (keyError) return keyError;
      const target = createObjectTarget(partition, bucket, operation.key);
      const response = await sendAwsRequest(partition, credentials, {
        target,
        method: "GET",
        service: "s3",
        headers: {},
      });
      if ("error" in response) return response;
      const errored = responseErrorOrNull(response);
      if (errored) return errored;
      if (operation.kind === "getText") {
        return new TextDecoder("utf-8").decode(response.bytes);
      }
      const base64 = Buffer.from(response.bytes).toString("base64");
      const { globals } = getRuntimeContext();
      globals.markRedacted(base64, BINARY_MARKER);
      return base64;
    }
    case "putText":
    case "putBinary": {
      const keyError = keyFailure(operation.key);
      if (keyError) return keyError;
      let body: Uint8Array;
      if (operation.kind === "putText") {
        body = new TextEncoder().encode(operation.content);
      } else {
        try {
          body = decodeBase64Strict(operation.base64);
        } catch (e) {
          return failure({ message: (e as Error).message });
        }
      }
      const sizeError = objectSizeFailure(body);
      if (sizeError) return sizeError;
      const target = createObjectTarget(partition, bucket, operation.key);
      const response = await sendAwsRequest(partition, credentials, {
        target,
        method: "PUT",
        service: "s3",
        body,
        headers: { "content-type": operation.contentType },
      });
      if ("error" in response) return response;
      const errored = responseErrorOrNull(response);
      if (errored) return errored;
      const etag = (response.headers.get("etag") ?? "").replace(/"/g, "");
      return { bucket: bucket.name, key: operation.key, url: response.url, etag };
    }
    case "createBucket": {
      const target = createBucketTarget(partition, bucket);
      const body =
        partition.region === "us-east-1"
          ? ""
          : `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
            `<LocationConstraint>${partition.region}</LocationConstraint></CreateBucketConfiguration>`;
      const response = await sendAwsRequest(partition, credentials, {
        target,
        method: "PUT",
        service: "s3",
        body,
        headers: {},
      });
      if ("error" in response) return response;
      const errored = responseErrorOrNull(response);
      if (errored) return errored;
      const location = response.headers.get("location") ?? `/${bucket.name}`;
      return { bucket: bucket.name, region: partition.region, location };
    }
    case "presignGet": {
      const keyError = keyFailure(operation.key);
      if (keyError) return keyError;
      const expiryError = expiresFailure(operation.expiresInSeconds);
      if (expiryError) return expiryError;
      const target = createObjectTarget(partition, bucket, operation.key);
      // Presigning never calls sendAwsRequest, so the final hostname defense
      // must run here explicitly.
      const hostError = hostOutsidePartitionFailure(target, partition);
      if (hostError) return hostError;
      const url = presignRequest({
        method: "GET",
        target,
        region: partition.region,
        service: "s3",
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
        expiresInSeconds: operation.expiresInSeconds,
      });
      const { globals } = getRuntimeContext();
      globals.markRedacted(url, PRESIGN_MARKER);
      return url;
    }
  }
}

export function _s3Get(
  bucket: string,
  key: string,
  region: string,
): Promise<S3OperationResult> {
  return runS3Operation(region, { kind: "getText", bucket, key });
}

export function _s3GetBinary(
  bucket: string,
  key: string,
  region: string,
): Promise<S3OperationResult> {
  return runS3Operation(region, { kind: "getBinary", bucket, key });
}

export function _s3Put(
  bucket: string,
  key: string,
  content: string,
  region: string,
  contentType: string,
): Promise<S3OperationResult> {
  return runS3Operation(region, { kind: "putText", bucket, key, content, contentType });
}

export function _s3PutBinary(
  bucket: string,
  key: string,
  base64: string,
  region: string,
  contentType: string,
): Promise<S3OperationResult> {
  return runS3Operation(region, { kind: "putBinary", bucket, key, base64, contentType });
}

export function _s3PresignGet(
  bucket: string,
  key: string,
  expiresInSeconds: number,
  region: string,
): Promise<S3OperationResult> {
  return runS3Operation(region, { kind: "presignGet", bucket, key, expiresInSeconds });
}

export function _createBucket(
  bucket: string,
  region: string,
): Promise<S3OperationResult> {
  return runS3Operation(region, { kind: "createBucket", bucket });
}
