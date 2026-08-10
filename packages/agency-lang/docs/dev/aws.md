# AWS standard-library support (S3)

`std::aws/s3` lets Agency programs read and write S3 objects and create buckets
with **no AWS SDK dependency**. This note explains how the pieces fit together and
the contracts that keep it safe. The user-facing reference is generated from the
docstrings in `stdlib/aws/s3.agency`.

## Why no SDK

Every AWS request is an ordinary HTTPS request whose `Authorization` header is
computed by AWS Signature Version 4 (SigV4). SigV4 needs only SHA-256 and
HMAC-SHA-256, both in Node's built-in `crypto`. Produce the same header the SDK
would and AWS cannot tell the difference. We implement **plain SigV4 only** — not
SigV4a (the elliptic-curve, multi-region-access-point variant).

## The layers

The core is functional (no classes): `fetch` is stateless, there is no session to
hold, and per-run state may not live in TS module globals. Each layer is one
declarative call over a sealed imperative body.

- `lib/stdlib/aws/uri.ts` — `awsUriEncode(value, encodeSlash)`, the one place AWS
  path/query encoding lives.
- `lib/stdlib/base64.ts` + `lib/stdlib/objectBytes.ts` — the shared strict base64
  decoder and the single `AWS_OBJECT_BYTE_LIMIT` (10 MiB) with `objectSizeFailure`.
  `_writeBinary` reuses the same decoder.
- `lib/stdlib/aws/credentials.ts` — env-only credentials + region precedence
  (argument → `AWS_REGION` → `us-east-1`).
- `lib/stdlib/aws/endpoints.ts` — `resolveAwsPartition` (bounded policy, below),
  and `validateBucket` producing a `ValidatedBucket` with its addressing style.
- `lib/stdlib/aws/sigv4.ts` — `signRequest` (header signing, canonical URI
  passed verbatim) and `presignRequest` (query-string signing, consuming the
  atomic target).
- `lib/stdlib/aws/client.ts` — the atomic `AwsRequestTarget`, its constructor, and
  `sendAwsRequest`.
- `lib/stdlib/aws/errors.ts` — S3 error-XML → coded failure.
- `lib/stdlib/aws/s3.ts` — the `runS3Operation` executor and the five extern
  helpers.
- `stdlib/aws/s3.agency` — the Agency surface (effects, interrupts, destructive).

A second AWS product would add `dynamodb.ts` + `dynamodb.agency` and reuse the
uri/base64/credentials/endpoints/sigv4/client core untouched.

## Import path vs effect labels

The module is imported as `std::aws/s3` (slash — a file under `stdlib/`). Its
effects are labelled `std::aws::s3::get` etc. (colons — a free-form effect name).
The slash names a file; the colons name an effect. Both are intentional.

## The declarative executor

`runS3Operation(region, operation)` owns the entire imperative pipeline for all
operations in one `switch`: credential/partition/bucket resolution, key
checks, target construction, text/base64 codecs, the upload cap, transport, non-2xx
mapping, binary redaction, and result shaping. The extern helpers
(`_s3Get`, `_s3GetBinary`, `_s3Put`, `_s3PutBinary`, `_createBucket`,
`_s3PresignGet`) are one-call adapters. Adding an operation is a new variant plus
a new `case` — no plumbing is copied.

## Untrusted input: region, bucket, key

`region` and `bucket` are model/user-controlled.

- **Region → partition.** `resolveAwsPartition` validates the region syntax
  (rejecting `/ @ #` and whitespace, which could otherwise terminate a URL
  authority early) and maps a bounded set of partitions, rejecting the rest:
  commercial `af|ap|ca|eu|il|me|mx|sa|us` → `amazonaws.com`; GovCloud `us-gov-` →
  `amazonaws.com`; China `cn-` → `amazonaws.com.cn`; ISO `us-iso-` → `c2s.ic.gov`.
  ISO/GovCloud/China are checked before the broad commercial `us-` rule.
- **Bucket.** `validateBucket` applies the full general-purpose S3 naming rules
  (length, charset, boundaries, no adjacent dots/hyphens, not an IP, reserved
  prefixes/suffixes) and returns the addressing style. A raw bucket string never
  reaches endpoint construction — only a `ValidatedBucket` does.
- **Final hostname.** `sendAwsRequest` validates the derived wire URL's hostname is
  under the resolved partition suffix before signing or fetching.

## Exact key canonicalization

The endpoint builder encodes each key segment once with `awsUriEncode` and produces
both the wire URL and the canonical URI from that one encoding; `sendAwsRequest`
signs the canonical URI verbatim. It is **not** re-derived by decoding a normalized
`URL.pathname`, which would corrupt `.`/`..` segments, repeated slashes, or `%2F`.
Keys containing a complete `.` or `..` slash-delimited segment are rejected, because
`fetch` would normalize them so the signed path and fetched path diverge. The
reserved key `soap` forces path-style addressing.

## The atomic request target

`AwsRequestTarget` is `{ origin, canonicalUri }`. `createAwsRequestTarget` rejects a
non-bare or non-HTTPS origin and a canonical URI without a leading `/` or containing
`?`/`#`. Transport derives the one wire URL as `origin + canonicalUri`, so no type
or API ever carries an independently supplied wire/signing path pair. Query-bearing
operations are out of scope for this v1 target; add them by extending the
constructor atomically.

## Size limits, binary, and ETag

`AWS_OBJECT_BYTE_LIMIT` (10 MiB) bounds **both** directions: downloads via the
shared streaming capped reader (`readBodyBytesCapped`, which cancels the reader and
`throwIfAborted()`s so a pending read rejects rather than returning a prefix), and
uploads on the decoded/encoded bytes before signing. A 10 MiB binary object is
~13.3 MiB of base64. Binary is base64 in and out (matching `readBinary`/
`writeBinary`), strictly validated. Put results return the response `ETag`;
create-bucket returns the `Location` header.

## Presigned URLs (`s3PresignGet`)

`s3PresignGet(bucket, key, expiresInSeconds, region)` mints a time-limited
download URL for a private object: the query-string variant of SigV4
(`presignRequest` in `sigv4.ts`), where the signature rides in the query, only
`host` is signed, and the payload hash is the literal `UNSIGNED-PAYLOAD`. No
request is sent — the URL is pure local crypto.

The parts that are easy to get wrong:

- **The one-encoding contract extends to the query.** `presignRequest` builds
  its canonical query once and the returned URL is exactly
  `origin + canonicalUri + "?" + canonicalQuery + "&X-Amz-Signature=" + sig` —
  nothing decodes, re-encodes, or reorders between signing and emission.
- **`presignRequest` consumes the atomic `AwsRequestTarget`** (a type-only
  import from `client.ts`), never an independently supplied wire/signing pair.
  `AwsRequestTarget` itself stays query-free.
- **The final-hostname defense is NOT inherited.** It lives in
  `hostOutsidePartitionFailure` (`client.ts`), which `sendAwsRequest` calls —
  and presigning bypasses `sendAwsRequest`, so the `presignGet` executor case
  calls the helper explicitly. `s3.test.ts` injects a refusal through a partial
  mock to prove the call happens.
- **Interrupt-gated but not `destructive`.** Minting a URL anyone can use is a
  capability grant, so it interrupts like everything else here — and uniquely,
  its payload carries `expiresInSeconds`, because a handler judging a share
  link needs to know how long it lives. Nothing remote changes, so checkpoint
  replay is harmless and there is no `destructive { }` region.
- **The URL is a bearer credential and is redacted from statelog** with the
  marker `[presigned S3 URL redacted]` (same `markRedacted` machinery as
  binary downloads). The runtime value is untouched — Agency code can still
  email the link; it just never lands in a trace.
- **Expiry is validated, never clamped:** an integer in `[1, 604800]` (7 days,
  the SigV4 maximum) or a coded failure. With temporary credentials
  (`AWS_SESSION_TOKEN`), AWS kills the URL when the session ends regardless.

The correctness anchor is AWS's published presigned-GET vector
(`sigv4.test.ts` reproduces the full documented URL byte-for-byte); a separate
hostile-input case pins the encoding contract with a key and session token full
of characters that must be encoded exactly once.

## Interrupts, destructive, and statelog redaction

Reads are interrupt-gated; writes (`s3Put`, `s3PutBinary`, `createBucket`) are
interrupt-gated **and** run inside a `destructive { }` region so retry/checkpoint
does not silently repeat them. Interrupt payloads carry only `{ bucket, key,
region }` — never object content.

Binary output is kept out of state logs by the existing redaction table, extended to
carry a custom marker: `globals.markRedacted(value, label?)` and
`globals.redactionReplacement(value)` drive **both** statelog composition points
(the `JSON.stringify` replacer and `runner.ts`'s `safeStatelogValue`), so a custom
label cannot leak through an equality check. `_s3GetBinary` marks its returned
base64 with `"[binary output truncated]"`. `std::tag`'s `redact(value, label?)`
exposes the same to Agency.

**Narrowed v1 guarantee:** downloaded binary results and interrupt payloads never
reach statelog verbatim. Binary that arrives *as a tool argument* is out of scope —
when `s3PutBinary` is exposed directly as an LLM tool, its base64 argument is
recorded at `toolCallStart`, before the helper runs, so redacting inside the helper
is too late. A generic sensitive-argument mechanism is future work.

## Limits

Plain SigV4 only (no SigV4a); no streaming or multipart uploads (the 10 MiB cap is
the real limit); env-only credentials (no shared config file / SSO / instance
metadata yet — `credentials.ts` is the seam); the `x-amz-security-token` path for
temporary credentials is supported.
