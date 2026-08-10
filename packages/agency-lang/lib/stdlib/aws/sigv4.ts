import { createHash, createHmac } from "crypto";
import { awsUriEncode } from "./uri.js";
import { type AwsRequestTarget } from "./client.js";

/**
 * AWS Signature Version 4 signing, using only Node's built-in crypto. The caller
 * supplies the canonical URI verbatim (already `awsUriEncode`d by the endpoint
 * builder) so the path that is signed is exactly the path that is fetched — no
 * re-derivation through URL normalization. Header signing (`signRequest`) signs
 * an empty canonical query because the request target carries no query;
 * presigning (`presignRequest`) builds its canonical query once and emits that
 * same string in the returned URL.
 *
 * Scope: plain SigV4 only (no SigV4a).
 */
export type SignInput = {
  method: string;
  /** Full wire URL, used for the host header. */
  wireUrl: string;
  /** The canonical URI to sign, verbatim (already encoded). */
  canonicalUri: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  body?: Uint8Array | string;
  extraHeaders?: Readonly<Record<string, string>>;
  /** Override "now"; used only to reproduce AWS's published test vectors. */
  date?: Date;
};

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function amzDates(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString(); // 2013-05-24T00:00:00.000Z
  const amzDate =
    iso.slice(0, 4) +
    iso.slice(5, 7) +
    iso.slice(8, 10) +
    "T" +
    iso.slice(11, 13) +
    iso.slice(14, 16) +
    iso.slice(17, 19) +
    "Z";
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function deriveSigningKey(
  secret: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac("AWS4" + secret, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/** Sign a request and return the headers to send, including Authorization. */
export function signRequest(input: SignInput): Record<string, string> {
  const now = input.date ?? new Date();
  const { amzDate, dateStamp } = amzDates(now);
  const host = new URL(input.wireUrl).host;
  const body = input.body ?? "";
  const payloadHash = sha256Hex(body);

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (input.sessionToken) {
    headers["x-amz-security-token"] = input.sessionToken;
  }
  for (const [name, value] of Object.entries(input.extraHeaders ?? {})) {
    headers[name.toLowerCase()] = value;
  }

  const sortedNames = Object.keys(headers).sort();
  const canonicalHeaders =
    sortedNames
      .map((name) => `${name}:${headers[name].trim().replace(/\s+/g, " ")}`)
      .join("\n") + "\n";
  const signedHeaders = sortedNames.join(";");

  const canonicalRequest = [
    input.method,
    input.canonicalUri,
    "", // empty canonical query in v1
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = deriveSigningKey(
    input.secretAccessKey,
    dateStamp,
    input.region,
    input.service,
  );
  const signature = hmac(signingKey, stringToSign).toString("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { ...headers, Authorization: authorization };
}

export type PresignInput = {
  method: string;
  /** The atomic target; the wire URL is derived as origin + canonicalUri. */
  target: AwsRequestTarget;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiresIn: number;
  /** Override "now"; used only to reproduce AWS's published test vectors. */
  date?: Date;
};

/**
 * Presign a request: the query-string variant of SigV4. Only `host` is signed
 * and the payload hash is the literal UNSIGNED-PAYLOAD, so anyone holding the
 * returned URL can send the request until the expiry. The canonical query that
 * is signed is byte-for-byte the query emitted in the URL (plus the trailing
 * X-Amz-Signature).
 */
export function presignRequest(input: PresignInput): string {
  const now = input.date ?? new Date();
  const { amzDate, dateStamp } = amzDates(now);
  const wireUrl = input.target.origin + input.target.canonicalUri;
  const host = new URL(input.target.origin).host;

  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const params: [string, string][] = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${input.accessKeyId}/${credentialScope}`],
    ["X-Amz-Date", amzDate],
    // ms to whole seconds: X-Amz-Expires must be an integer. Round up so a
    // sub-second remainder never silently shortens the requested lifetime.
    ["X-Amz-Expires", String(Math.ceil(input.expiresIn / 1000))],
    ["X-Amz-SignedHeaders", "host"],
  ];
  if (input.sessionToken) {
    params.push(["X-Amz-Security-Token", input.sessionToken]);
  }
  const canonicalQuery = params
    .map(([name, value]) => [awsUriEncode(name, true), awsUriEncode(value, true)])
    // Code-unit comparison, deliberately not localeCompare: the sort order is
    // part of the signature and must not vary by locale.
    .sort(([a], [b]) => {
      if (a === b) {
        return 0;
      }
      return a < b ? -1 : 1;
    })
    .map(([name, value]) => `${name}=${value}`)
    .join("&");

  const canonicalRequest = [
    input.method,
    input.target.canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = deriveSigningKey(
    input.secretAccessKey,
    dateStamp,
    input.region,
    input.service,
  );
  const signature = hmac(signingKey, stringToSign).toString("hex");

  return `${wireUrl}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
