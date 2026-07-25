// Spike: does the ALS shim keep per-branch context isolated ACROSS awaits
// under concurrency? This mimics exactly what Agency's fork/runBatch does:
// each branch body runs inside its own als.run(branchStore, ...) frame and
// then awaits (an llm() call, in real life).
//
// Usage: node spike.mjs zone   (or)   node spike.mjs naive
const which = process.argv[2] ?? "zone";
const { AsyncLocalStorage } =
  which === "naive"
    ? await import("./naive-als.mjs")
    : await import("./zone-als.mjs");

const als = new AsyncLocalStorage();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One "branch" of a fork. It reads its store, awaits (like an LLM call),
// then reads its store AGAIN. Both reads must see the SAME branch store.
async function branch(expectedId, delayMs) {
  const before = als.getStore()?.id;
  await sleep(delayMs); // suspend — control goes to the other branch here
  await Promise.resolve(); // extra microtask hop for good measure
  const after = als.getStore()?.id;
  return { expectedId, before, after };
}

// Launch two branches concurrently, each in its own run() frame, with
// interleaved delays so branch B sets the "current" store while A is
// suspended. This is what clobbers the naive polyfill.
const pA = als.run({ id: "A" }, () => branch("A", 30));
const pB = als.run({ id: "B" }, () => branch("B", 5));

const [ra, rb] = await Promise.all([pA, pB]);

// Nested case: a branch that itself forks (parent-zone walk).
const nested = await als.run({ id: "outer" }, async () => {
  const outerBefore = als.getStore()?.id;
  const inner = await als.run({ id: "inner" }, async () => {
    await sleep(10);
    return als.getStore()?.id;
  });
  await sleep(10);
  const outerAfter = als.getStore()?.id; // must still be "outer"
  return { outerBefore, inner, outerAfter };
});

const results = [ra, rb];
let ok = true;
console.log(`\n=== shim: ${which} ===`);
for (const r of results) {
  const pass = r.before === r.expectedId && r.after === r.expectedId;
  ok = ok && pass;
  console.log(
    `branch ${r.expectedId}: before=${r.before} after=${r.after}  ${
      pass ? "PASS" : "FAIL <-- context leaked across await"
    }`,
  );
}
const nestedPass =
  nested.outerBefore === "outer" &&
  nested.inner === "inner" &&
  nested.outerAfter === "outer";
ok = ok && nestedPass;
console.log(
  `nested: outerBefore=${nested.outerBefore} inner=${nested.inner} outerAfter=${nested.outerAfter}  ${
    nestedPass ? "PASS" : "FAIL"
  }`,
);

console.log(`\nRESULT: ${ok ? "ALL PASS ✅" : "FAILED ❌"}\n`);
process.exit(ok ? 0 : 1);
