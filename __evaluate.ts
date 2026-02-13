import { foo } from "./foo.ts";

async function main() {
  const result = await foo();
  console.log("Evaluation result:", result.data);
}

main();