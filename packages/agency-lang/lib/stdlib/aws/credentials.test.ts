import { resolveAwsCredentials, resolveRegion, type AwsCredentials } from "./credentials.js";

const ORIGINAL_ENV = process.env;
beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});
afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe("resolveAwsCredentials", () => {
  it("fails clearly when keys are missing", () => {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    const result = resolveAwsCredentials();
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.message).toContain("AWS_ACCESS_KEY_ID");
    }
  });

  it("reads keys and a session token when present", () => {
    process.env.AWS_ACCESS_KEY_ID = "AKID";
    process.env.AWS_SECRET_ACCESS_KEY = "SECRET";
    process.env.AWS_SESSION_TOKEN = "TOKEN";
    const result = resolveAwsCredentials() as AwsCredentials;
    expect(result.accessKeyId).toBe("AKID");
    expect(result.secretAccessKey).toBe("SECRET");
    expect(result.sessionToken).toBe("TOKEN");
  });

  it("omits the session token when it is absent", () => {
    process.env.AWS_ACCESS_KEY_ID = "AKID";
    process.env.AWS_SECRET_ACCESS_KEY = "SECRET";
    delete process.env.AWS_SESSION_TOKEN;
    const result = resolveAwsCredentials() as AwsCredentials;
    expect(result.sessionToken).toBeUndefined();
  });
});

describe("resolveRegion", () => {
  it("prefers the argument, then AWS_REGION, then us-east-1", () => {
    process.env.AWS_REGION = "eu-west-1";
    expect(resolveRegion("ap-south-1")).toBe("ap-south-1");
    expect(resolveRegion("")).toBe("eu-west-1");
    delete process.env.AWS_REGION;
    expect(resolveRegion("")).toBe("us-east-1");
  });
});
