import { resolveAwsPartition, validateBucket, BUCKET_NAME_MAX_LENGTH } from "./endpoints.js";

describe("resolveAwsPartition", () => {
  it("maps commercial, GovCloud, China, and ISO regions to exact suffixes", () => {
    expect(resolveAwsPartition("us-east-1")).toEqual({
      region: "us-east-1",
      dnsSuffix: "amazonaws.com",
    });
    expect(resolveAwsPartition("us-gov-west-1")).toEqual({
      region: "us-gov-west-1",
      dnsSuffix: "amazonaws.com",
    });
    expect(resolveAwsPartition("cn-north-1")).toEqual({
      region: "cn-north-1",
      dnsSuffix: "amazonaws.com.cn",
    });
    expect(resolveAwsPartition("us-iso-east-1")).toEqual({
      region: "us-iso-east-1",
      dnsSuffix: "c2s.ic.gov",
    });
  });

  it.each([
    "us-east-1/evil.com",
    "us-east-1@evil",
    "us east 1",
    "us#1",
    "",
    "US-EAST-1",
    "useast1",
    "zz-west-1",
  ])("rejects malformed or unsupported region %s", (bad) => {
    expect("error" in (resolveAwsPartition(bad) as object)).toBe(true);
  });
});

describe("validateBucket", () => {
  it("accepts a plain name as virtual-hosted", () => {
    expect(validateBucket("my-bucket")).toEqual({
      name: "my-bucket",
      addressing: "virtualHosted",
    });
  });

  it("accepts a dotted name as path-style", () => {
    expect(validateBucket("data.exports")).toEqual({
      name: "data.exports",
      addressing: "pathStyle",
    });
  });

  it.each([
    "",
    "ab",
    "a".repeat(BUCKET_NAME_MAX_LENGTH + 1),
    "Uppercase",
    "bad_name",
    "-leading",
    "trailing-",
    ".leading",
    "trailing.",
    "label.-bad",
    "label-.bad",
    "two..dots",
    "192.168.0.1",
    "xn--bucket",
    "sthree-bucket",
    "amzn-s3-demo-bucket",
    "bucket-s3alias",
    "bucket--ol-s3",
    "bucket.mrap",
    "bucket--x-s3",
    "bucket--table-s3",
  ])("rejects invalid bucket %s", (bad) => {
    expect("error" in (validateBucket(bad) as object)).toBe(true);
  });
});
