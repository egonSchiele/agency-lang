import { failure, type ResultFailure } from "../../runtime/result.js";

/**
 * AWS credentials read from the environment — the only credential source in v1.
 * Region is resolved separately (see `resolveRegion`) and validated into a
 * partition (see `endpoints.ts`).
 */
export type AwsCredentials = {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
};

/** Read AWS credentials from the environment, or a `failure` naming what's missing. */
export function resolveAwsCredentials(): AwsCredentials | ResultFailure {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? "";
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY ?? "";
  if (!accessKeyId || !secretAccessKey) {
    return failure({
      message:
        "AWS credentials not found. Set AWS_ACCESS_KEY_ID and " +
        "AWS_SECRET_ACCESS_KEY in the environment.",
    });
  }
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: process.env.AWS_SESSION_TOKEN || undefined,
  };
}

/** Region precedence: explicit argument, then `AWS_REGION`, then `us-east-1`. */
export function resolveRegion(regionOverride: string): string {
  return regionOverride || process.env.AWS_REGION || "us-east-1";
}
