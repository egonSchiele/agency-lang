import { awsUriEncode } from "../uri.js";

describe("awsUriEncode", () => {
  it("keeps path slashes, encodes space/percent/unicode once (encodeSlash false)", () => {
    expect(awsUriEncode("a/b %雪", false)).toBe("a/b%20%25%E9%9B%AA");
  });
  it("encodes slashes when encodeSlash is true", () => {
    expect(awsUriEncode("a/b", true)).toBe("a%2Fb");
  });
  it("leaves unreserved characters literal", () => {
    expect(awsUriEncode("Az0-._~", false)).toBe("Az0-._~");
  });
  it("uppercases hex", () => {
    expect(awsUriEncode("~ ", false)).toBe("~%20");
    expect(awsUriEncode(":", false)).toBe("%3A");
  });
});
