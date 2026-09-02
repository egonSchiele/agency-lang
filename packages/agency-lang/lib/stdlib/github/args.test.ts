import { describe, it, expect } from "vitest";
import { _ghClampPerPage, _ghClampPage, _ghCheckNumber, pagingQuery } from "./args.js";

describe("paging clamps", () => {
  it.each([
    [500, 0, "100", "1"],
    [0, 0, "1", "1"],
    [-5, -5, "1", "1"],
    [30.7, 2.9, "30", "2"],
    [NaN, NaN, "1", "1"],
    [Infinity, Infinity, "1", "1"],
    [-Infinity, -Infinity, "1", "1"],
    [50, 3, "50", "3"],
  ])("perPage=%s page=%s -> per_page=%s page=%s", (perPage, page, wantPerPage, wantPage) => {
    expect(pagingQuery(perPage, page)).toEqual({ per_page: wantPerPage, page: wantPage });
    expect(String(_ghClampPerPage(perPage))).toBe(wantPerPage);
    expect(String(_ghClampPage(page))).toBe(wantPage);
  });
});

describe("_ghCheckNumber", () => {
  it.each([[1], [7], [123456]])("accepts %s", (n) => {
    expect(() => _ghCheckNumber(n)).not.toThrow();
  });
  it.each([[0], [-1], [7.5], [NaN], [Infinity]])("refuses %s", (n) => {
    expect(() => _ghCheckNumber(n)).toThrow(/positive whole/);
  });
});
