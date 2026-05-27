import { agency } from "agency-lang/runtime";

// Tracks how many times each step body actually executed. Used by
// test.js to verify the basic happy path (each step fires exactly
// once when no resume / halt is involved).
export const calls = { s1: 0, s2: 0, s3: 0 };

export async function processOrder(orderId) {
  return agency.withResumableScope({ name: "processOrder" }, async (s) => {
    const order = await s.step(async () => {
      calls.s1 += 1;
      return { id: orderId, amount: 100 };
    });
    const validated = await s.step(async () => {
      calls.s2 += 1;
      return { ...order, validated: true };
    });
    const stored = await s.step(async () => {
      calls.s3 += 1;
      return { ...validated, stored: true };
    });
    return stored;
  });
}
