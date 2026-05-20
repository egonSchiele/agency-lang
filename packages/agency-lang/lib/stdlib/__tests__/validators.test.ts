import { describe, it, expect } from "vitest";
import {
  _isEmail,
  _isUrl,
  _isUuid,
  _isInt,
  _isPositive,
  _isNegative,
  _min,
  _max,
  _minLength,
  _maxLength,
  _matches,
} from "../validators.js";
import { isSuccess, isFailure } from "../../runtime/result.js";

describe("simple validators", () => {
  it("isEmail accepts valid addresses and rejects junk", () => {
    expect(isSuccess(_isEmail("a@b.com"))).toBe(true);
    expect(isFailure(_isEmail("not-an-email"))).toBe(true);
  });

  it("isUrl accepts http/https and rejects everything else", () => {
    expect(isSuccess(_isUrl("https://example.com"))).toBe(true);
    expect(isSuccess(_isUrl("http://localhost:3000/x"))).toBe(true);
    expect(isFailure(_isUrl("ftp://example.com"))).toBe(true);
    expect(isFailure(_isUrl("example.com"))).toBe(true);
  });

  it("isUuid accepts canonical UUIDs and rejects malformed", () => {
    expect(isSuccess(_isUuid("123e4567-e89b-12d3-a456-426614174000"))).toBe(
      true,
    );
    expect(isFailure(_isUuid("not-a-uuid"))).toBe(true);
  });

  it("isInt accepts integers and rejects fractionals", () => {
    expect(isSuccess(_isInt(5))).toBe(true);
    expect(isFailure(_isInt(5.5))).toBe(true);
  });

  it("isPositive / isNegative respect the boundary at 0", () => {
    expect(isSuccess(_isPositive(1))).toBe(true);
    expect(isFailure(_isPositive(0))).toBe(true);
    expect(isFailure(_isPositive(-1))).toBe(true);
    expect(isSuccess(_isNegative(-1))).toBe(true);
    expect(isFailure(_isNegative(0))).toBe(true);
  });
});

describe("parameterized validators", () => {
  it("min(n) accepts >= n and rejects < n", () => {
    const ge5 = _min(5);
    expect(isSuccess(ge5(5))).toBe(true);
    expect(isSuccess(ge5(10))).toBe(true);
    expect(isFailure(ge5(4))).toBe(true);
  });

  it("max(n) accepts <= n and rejects > n", () => {
    const le10 = _max(10);
    expect(isSuccess(le10(10))).toBe(true);
    expect(isSuccess(le10(0))).toBe(true);
    expect(isFailure(le10(11))).toBe(true);
  });

  it("minLength(n) checks string length", () => {
    const at_least_3 = _minLength(3);
    expect(isSuccess(at_least_3("abc"))).toBe(true);
    expect(isSuccess(at_least_3("abcd"))).toBe(true);
    expect(isFailure(at_least_3("ab"))).toBe(true);
  });

  it("maxLength(n) checks string length", () => {
    const atMost5 = _maxLength(5);
    expect(isSuccess(atMost5("hi"))).toBe(true);
    expect(isSuccess(atMost5("hello"))).toBe(true);
    expect(isFailure(atMost5("hellos"))).toBe(true);
  });

  it("matches accepts both string and RegExp patterns", () => {
    const digits = _matches(/^\d+$/);
    expect(isSuccess(digits("12345"))).toBe(true);
    expect(isFailure(digits("abc"))).toBe(true);

    const fromString = _matches("^abc$");
    expect(isSuccess(fromString("abc"))).toBe(true);
    expect(isFailure(fromString("abcd"))).toBe(true);
  });

  it("each factory call returns a fresh closure that captures its params", () => {
    // This is the contract that lets users write `@validate(min(5))` AND
    // `@validate(min(10))` on different aliases without interference.
    const ge5 = _min(5);
    const ge10 = _min(10);
    expect(isSuccess(ge5(7))).toBe(true);
    expect(isFailure(ge10(7))).toBe(true);
  });

  it("failure messages mention the parameter for easy debugging", () => {
    const r = _min(5)(3);
    expect(isFailure(r)).toBe(true);
    if (isFailure(r)) {
      expect(r.error).toMatch(/>= 5/);
    }
  });
});
