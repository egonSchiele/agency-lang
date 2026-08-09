import { AWS_OBJECT_BYTE_LIMIT, objectSizeFailure } from "../objectBytes.js";

describe("objectSizeFailure", () => {
  it("passes an object exactly at the limit", () => {
    expect(objectSizeFailure(new Uint8Array(AWS_OBJECT_BYTE_LIMIT))).toBeNull();
  });
  it("fails an object one byte over the limit", () => {
    const failure = objectSizeFailure(new Uint8Array(AWS_OBJECT_BYTE_LIMIT + 1));
    expect(failure).not.toBeNull();
    expect(failure!.error.message).toContain(String(AWS_OBJECT_BYTE_LIMIT));
  });
  it("passes an empty object", () => {
    expect(objectSizeFailure(new Uint8Array(0))).toBeNull();
  });
});
