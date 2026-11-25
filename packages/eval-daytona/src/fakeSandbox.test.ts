import { expect, it } from "vitest";

import { FakeSandbox } from "./fakeSandbox.js";

it("answers exit 0 and empty output by default", async () => {
  expect(await new FakeSandbox().exec("ls")).toEqual({ exitCode: 0, output: "" });
});
it("records exec and background lines in order", async () => {
  const sandbox = new FakeSandbox();
  await sandbox.exec("a");
  await sandbox.startBackground("b");
  expect(sandbox.commands).toEqual(["a", "b"]);
  expect(sandbox.background).toEqual(["b"]);
});
it("round-trips an uploaded file", async () => {
  const sandbox = new FakeSandbox();
  await sandbox.upload(Buffer.from("abc"), "/tmp/a");
  expect((await sandbox.download("/tmp/a")).toString()).toBe("abc");
});
it("throws on a download of a file never uploaded", async () => {
  await expect(new FakeSandbox().download("/nope")).rejects.toThrow("/nope");
});
it("lets a reply throw", async () => {
  const sandbox = new FakeSandbox(() => {
    throw new Error("502");
  });
  await expect(sandbox.exec("x")).rejects.toThrow("502");
});
it("marks itself deleted", async () => {
  const sandbox = new FakeSandbox();
  await sandbox.delete();
  expect(sandbox.deleted).toBe(true);
});
