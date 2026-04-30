import { approve, hasInterrupts, main, respondToInterrupts } from "./foo.js"

async function run() {
  let result = await main()
  while (hasInterrupts(result.data)) {
    const answers = [];
    for (const interrupt of result.data) {
      console.log("Interrupts detected in the result:",
        interrupt.data)
      answers.push(approve())
    }
    result = await respondToInterrupts(result.data, answers)
  }
  console.log("Final result:", result)
}

await run()