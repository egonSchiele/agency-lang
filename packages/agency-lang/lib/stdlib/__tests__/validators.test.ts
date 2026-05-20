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
  it("min(n, value) accepts >= n and rejects < n", () => {
    expect(isSuccess(_min(5, 5))).toBe(true);
    expect(isSuccess(_min(5, 10))).toBe(true);
    expect(isFailure(_min(5, 4))).toBe(true);
  });

  it("max(n, value) accepts <= n and rejects > n", () => {
    expect(isSuccess(_max(10, 10))).toBe(true);
    expect(isSuccess(_max(10, 0))).toBe(true);
    expect(isFailure(_max(10, 11))).toBe(true);
  });

  it("minLength(n, value) checks string length", () => {
    expect(isSuccess(_minLength(3, "abc"))).toBe(true);
    expect(isSuccess(_minLength(3, "abcd"))).toBe(true);
    expect(isFailure(_minLength(3, "ab"))).toBe(true);
  });

  it("maxLength(n, value) checks string length", () => {
    expect(isSuccess(_maxLength(5, "hi"))).toBe(true);
    expect(isSuccess(_maxLength(5, "hello"))).toBe(true);
    expect(isFailure(_maxLength(5, "hellos"))).toBe(true);
  });

  it("matches accepts a string regex source", () => {
    expect(isSuccess(_matches("^\\d+$", "12345"))).toBe(true);
    expect(isFailure(_matches("^\\d+$", "abc"))).toBe(true);

    expect(isSuccess(_matches("^abc$", "abc"))).toBe(true);
    expect(isFailure(_matches("^abc$", "abcd"))).toBe(true);
  });

  it("failure messages mention the parameter for easy debugging", () => {
    const r = _min(5, 3);
    expect(isFailure(r)).toBe(true);
    if (isFailure(r)) {
      expect(r.error).toMatch(/>= 5/);
    }
  });
});
