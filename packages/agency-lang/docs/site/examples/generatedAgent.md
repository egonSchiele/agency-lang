[View source](https://github.com/egonSchiele/agency-lang/blob/main/packages/agency-lang/examples/generatedAgent.agency)

```ts
import { fill, runCode, toSource } from "std::agency"
```

In this example, an LLM generates the code for an Agency agent, and then executes that agent.
The generated agent is a simple research agent.

```ts
def writeResearchAgent(researchTopic: string): Result<string> {
  """
  Generates a research agent for the given topic using Agency.
  """
```

Using [Template Agency](/guide/template-agency) to generate the code for a research agent.
  The topic hole is filled with the research topic provided by the user.

```ts
  const template = [|
    node main() {
      const topic = #topic
      const res = llm("Research the topic: ${topic} and provide a summary of findings.")
      return res
    }
  |]
  const res = fill(template, {
    topic: researchTopic
  })
  return res |> toSource
}
```

Ask an LLM to generate a research agent for the topic of "quantum computing",
print the generated code, and then run that agent.

You will need to run this in interactive mode (`agency run --interactive generatedAgent.agency`)
to respond to the `std::run` interrupt from `runCode`.

```ts
node main() {
  const res = llm(
    "Write and run a research agent for the topic of 'quantum computing'. Please print the code before you run it.",
    tools: [writeResearchAgent, runCode, print],
  )
  print(res)
  return res
}
```
