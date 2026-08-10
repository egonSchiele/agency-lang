import { failure, type ResultFailure } from "../../runtime/result.js";

export const BUCKET_NAME_MIN_LENGTH = 3;
export const BUCKET_NAME_MAX_LENGTH = 63;

/**
 * A resolved and validated AWS partition: the region and the DNS suffix its
 * endpoints live under. V1 supports a bounded set of partitions and rejects
 * everything else rather than guessing a suffix.
 */
export type AwsPartition = {
  readonly region: string;
  readonly dnsSuffix: string;
};

// A region is lowercase alphanumerics in hyphen-separated groups (at least two),
// e.g. "us-east-1". This rejects anything with `/ @ # ` or whitespace, which
// could otherwise terminate a URL authority early.
const REGION_SYNTAX = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;

/**
 * Validate a region and resolve its partition suffix. ISO, GovCloud, and China
 * are checked before the broad commercial rule so their bounded prefixes are not
 * swallowed by the commercial `us-` match.
 */
export function resolveAwsPartition(region: string): AwsPartition | ResultFailure {
  if (!REGION_SYNTAX.test(region)) {
    return failure({
      message: `Invalid AWS region ${JSON.stringify(region)}. Expected a value like "us-east-1".`,
    });
  }
  if (region.startsWith("us-iso-")) return { region, dnsSuffix: "c2s.ic.gov" };
  if (region.startsWith("us-gov-")) return { region, dnsSuffix: "amazonaws.com" };
  if (region.startsWith("cn-")) return { region, dnsSuffix: "amazonaws.com.cn" };
  if (/^(af|ap|ca|eu|il|me|mx|sa|us)-/.test(region)) {
    return { region, dnsSuffix: "amazonaws.com" };
  }
  return failure({
    message: `Unsupported AWS partition for region ${JSON.stringify(region)}.`,
  });
}

export type BucketAddressing = "virtualHosted" | "pathStyle";

/**
 * A bucket name that has passed the general-purpose S3 naming rules, paired with
 * the addressing style it is safe for. Only `validateBucket` produces one, so a
 * raw, unchecked bucket string can never reach endpoint construction.
 */
export type ValidatedBucket = {
  readonly name: string;
  readonly addressing: BucketAddressing;
};

const BUCKET_CHARSET = /^[a-z0-9.-]+$/;
// Must begin and end with a lowercase letter or number.
const BUCKET_ENDS = /^[a-z0-9].*[a-z0-9]$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const RESERVED_PREFIXES = ["xn--", "sthree-", "amzn-s3-demo-"];
const RESERVED_SUFFIXES = ["-s3alias", "--ol-s3", ".mrap", "--x-s3", "--table-s3"];

/** Validate an S3 general-purpose bucket name and choose its addressing style. */
export function validateBucket(name: string): ValidatedBucket | ResultFailure {
  const reject = (reason: string): ResultFailure =>
    failure({ message: `Invalid S3 bucket name ${JSON.stringify(name)}: ${reason}.` });

  if (name.length < BUCKET_NAME_MIN_LENGTH || name.length > BUCKET_NAME_MAX_LENGTH) {
    return reject(`length must be ${BUCKET_NAME_MIN_LENGTH}-${BUCKET_NAME_MAX_LENGTH} characters`);
  }
  if (!BUCKET_CHARSET.test(name)) {
    return reject("only lowercase letters, numbers, dots, and hyphens are allowed");
  }
  if (!BUCKET_ENDS.test(name)) {
    return reject("must begin and end with a letter or number");
  }
  if (name.includes("..")) {
    return reject("must not contain consecutive dots");
  }
  if (name.includes(".-") || name.includes("-.")) {
    return reject("dots and hyphens must not be adjacent");
  }
  if (IPV4.test(name)) {
    return reject("must not be formatted as an IP address");
  }
  for (const prefix of RESERVED_PREFIXES) {
    if (name.startsWith(prefix)) {
      return reject(`must not start with the reserved prefix "${prefix}"`);
    }
  }
  for (const suffix of RESERVED_SUFFIXES) {
    if (name.endsWith(suffix)) {
      return reject(`must not end with the reserved suffix "${suffix}"`);
    }
  }
  // A dotted name cannot use virtual-hosted style over HTTPS (the wildcard TLS
  // certificate would not match), so it is addressed path-style.
  const addressing: BucketAddressing = name.includes(".") ? "pathStyle" : "virtualHosted";
  return { name, addressing };
}
