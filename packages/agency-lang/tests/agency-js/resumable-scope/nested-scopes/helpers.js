import { agency } from "agency-lang/runtime";

export const calls = { o1: 0, o2: 0, i1: 0, i2: 0 };

export async function outerProcess(seed) {
  return agency.withResumableScope({ name: "outer" }, async (outerS) => {
    const a = await outerS.step(() => {
      calls.o1 += 1;
      return seed + "/o1";
    });

    const b = await outerS.step(async () => {
      calls.o2 += 1;
      // Nested scope inside an outer step — exercises real frame
      // stacking through `setupFunction()` in a live Agency
      // execution context.
      return agency.withResumableScope({ name: "inner" }, async (innerS) => {
        const x = await innerS.step(() => {
          calls.i1 += 1;
          return "i1";
        });
        const y = await innerS.step(() => {
          calls.i2 += 1;
          return "i2";
        });
        return `${x}+${y}`;
      });
    });

    return `${a}|${b}`;
  });
}
