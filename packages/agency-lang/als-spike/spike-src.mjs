// Same concurrency + nested test as spike.mjs, but written with native
// async/await and STATICALLY importing the zone shim, so we can transpile
// the whole thing to es2016 (async -> .then) and check Zone tracks it.
import { AsyncLocalStorage } from "./zone-als.mjs";

const als = new AsyncLocalStorage();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function branch(expectedId, delayMs) {
  const before = als.getStore()?.id;
  await sleep(delayMs);
  await Promise.resolve();
  const after = als.getStore()?.id;
  return { expectedId, before, after };
}

async function main() {
  const pA = als.run({ id: "A" }, () => branch("A", 30));
  const pB = als.run({ id: "B" }, () => branch("B", 5));
  const [ra, rb] = await Promise.all([pA, pB]);

  const nested = await als.run({ id: "outer" }, async () => {
    const outerBefore = als.getStore()?.id;
    const inner = await als.run({ id: "inner" }, async () => {
      await sleep(10);
      return als.getStore()?.id;
    });
    await sleep(10);
    const outerAfter = als.getStore()?.id;
    return { outerBefore, inner, outerAfter };
  });

  let ok = true;
  for (const r of [ra, rb]) {
    const pass = r.before === r.expectedId && r.after === r.expectedId;
    ok = ok && pass;
    console.log(`branch ${r.expectedId}: before=${r.before} after=${r.after}  ${pass ? "PASS" : "FAIL"}`);
  }
  const nestedPass = nested.outerBefore === "outer" && nested.inner === "inner" && nested.outerAfter === "outer";
  ok = ok && nestedPass;
  console.log(`nested: outerBefore=${nested.outerBefore} inner=${nested.inner} outerAfter=${nested.outerAfter}  ${nestedPass ? "PASS" : "FAIL"}`);
  console.log(`\nRESULT: ${ok ? "ALL PASS ✅" : "FAILED ❌"}`);
  process.exit(ok ? 0 : 1);
}

main();
