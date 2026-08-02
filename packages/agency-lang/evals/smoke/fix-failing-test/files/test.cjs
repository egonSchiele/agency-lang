// Run with: node test.cjs
// Exits 0 when every case passes, non-zero on the first failure.
const assert = require("assert");
const { median, mean } = require("./stats.cjs");

const cases = [
  ["median of an odd-length list", () => assert.strictEqual(median([5, 1, 100]), 5)],
  ["median of an even-length list", () => assert.strictEqual(median([10, 2, 33, 4]), 7)],
  ["median of a single value", () => assert.strictEqual(median([42]), 42)],
  ["median ignores input order", () => assert.strictEqual(median([3, 1, 2]), 2)],
  ["median handles negatives", () => assert.strictEqual(median([-5, -1, -3]), -3)],
  ["mean of a list", () => assert.strictEqual(mean([2, 4, 6]), 4)],
  ["mean of a single value", () => assert.strictEqual(mean([7]), 7)],
];

let failed = 0;
for (const [name, run] of cases) {
  try {
    run();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}: ${err.message}`);
  }
}

console.log(`\n${cases.length - failed}/${cases.length} passing`);
process.exit(failed === 0 ? 0 : 1);
