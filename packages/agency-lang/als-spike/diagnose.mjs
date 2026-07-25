import { AsyncLocalStorage } from "./zone-als.mjs";
const als = new AsyncLocalStorage();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Test 1: propagate across a bare setTimeout callback (no async/await)
function test1() {
  return als.run({ id: "T1" }, () => {
    return new Promise((resolve) => {
      setTimeout(() => resolve(als.getStore()?.id), 10);
    });
  });
}

// Test 2: propagate across an explicit .then() chain (no async/await)
function test2() {
  return als.run({ id: "T2" }, () => {
    return sleep(10).then(() => als.getStore()?.id);
  });
}

// Test 3: propagate across NATIVE async/await
function test3() {
  return als.run({ id: "T3" }, async () => {
    await sleep(10);
    return als.getStore()?.id;
  });
}

const t1 = await test1();
const t2 = await test2();
const t3 = await test3();
console.log(`Test 1 (setTimeout cb):   got=${t1}  expected=T1  ${t1 === "T1" ? "PASS" : "FAIL"}`);
console.log(`Test 2 (.then chain):     got=${t2}  expected=T2  ${t2 === "T2" ? "PASS" : "FAIL"}`);
console.log(`Test 3 (native await):    got=${t3}  expected=T3  ${t3 === "T3" ? "PASS" : "FAIL"}`);
