import { decodeBase64Strict } from "../base64.js";

describe("decodeBase64Strict", () => {
  it("decodes valid base64", () => {
    expect(Array.from(decodeBase64Strict("aGk="))).toEqual([104, 105]); // "hi"
  });
  it("ignores whitespace", () => {
    expect(Array.from(decodeBase64Strict("aG\n k="))).toEqual([104, 105]);
  });
  it.each(["aGk", "aG*=", "a===", "!!!!", "=aGk"])(
    "throws on invalid input %s",
    (bad) => {
      expect(() => decodeBase64Strict(bad)).toThrow(/base64/);
    },
  );
});
