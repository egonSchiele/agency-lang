import { describe, expect, it } from "vitest";
import { _isHttpUrl } from "./httpUrl.js";

describe("_isHttpUrl", () => {
  it("accepts an https URL with a port and a path", () => {
    expect(_isHttpUrl("https://my-mac.tailnet.ts.net:8090/v1")).toBe(true);
  });

  it("accepts an http URL", () => {
    expect(_isHttpUrl("http://127.0.0.1:8080/v1")).toBe(true);
  });

  it("refuses a scheme with no host", () => {
    expect(_isHttpUrl("https://")).toBe(false);
  });

  it("refuses an address with no scheme", () => {
    expect(_isHttpUrl("studio:8090/v1")).toBe(false);
  });

  it("refuses another scheme", () => {
    expect(_isHttpUrl("ftp://studio/v1")).toBe(false);
  });

  it("refuses an empty string", () => {
    expect(_isHttpUrl("")).toBe(false);
  });
});
