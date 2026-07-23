import { describe, expect, it } from "vitest";
import { objectTypeParser } from "./parsers.js";

describe("objectTypeParser — property tags", () => {
  it("attaches a single @validate tag to a property", () => {
    const src = `{
      @validate(isEmail)
      email: string
    }`;
    const r = objectTypeParser(src);
    expect(r.success).toBe(true);
    if (!r.success) return;
    const prop = r.result.properties[0];
    expect(prop.key).toBe("email");
    expect(prop.tags).toHaveLength(1);
    expect(prop.tags?.[0].name).toBe("validate");
  });

  it("attaches multiple stacked tags to a property", () => {
    const src = `{
      @validate(isEmail)
      @jsonSchema({ format: "email" })
      email: string
    }`;
    const r = objectTypeParser(src);
    expect(r.success).toBe(true);
    if (!r.success) return;
    const prop = r.result.properties[0];
    expect(prop.tags).toHaveLength(2);
    expect(prop.tags?.[0].name).toBe("validate");
    expect(prop.tags?.[1].name).toBe("jsonSchema");
  });

  it("plain property still parses with no tags", () => {
    const src = `{ name: string }`;
    const r = objectTypeParser(src);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.properties[0].tags).toBeUndefined();
  });

  it("tags do not leak across properties", () => {
    const src = `{
      @validate(isEmail)
      email: string,
      name: string
    }`;
    const r = objectTypeParser(src);
    expect(r.success).toBe(true);
    if (!r.success) return;
    const emailProp = r.result.properties.find((p) => p.key === "email");
    const nameProp = r.result.properties.find((p) => p.key === "name");
    expect(emailProp?.tags).toHaveLength(1);
    expect(nameProp?.tags).toBeUndefined();
  });

});
