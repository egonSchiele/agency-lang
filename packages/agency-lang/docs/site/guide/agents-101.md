# Agents 101
If you are new to building agents, read this first. 

At its heart, an agent is very simple. It is:
- an LLM call,
- some tools, and
- a loop.

Let's walk through those one at a time.

## An LLM call

This is just a call you make to an API endpoint. You send a message and you get a message back in response. Agency exposes an `llm` function that you can use to make the call:

```ts
const response = llm("What is the capital of India?")
```

This is the most fundamental interaction with any LLM – sending a message and getting a response back.

### Structured Responses
Before we talk about tools, we need to talk about structured responses.

All LLM providers quickly figured out that it would be very useful if the response could be returned in a structured format. For example, suppose you want to categorize a user's mood based on their message. Then you want to say something specific based on their mood. Here's some example Agency code:

```ts
const mood = llm("What is the user's mood based on this message: 'I am feeling great today!'?")
if (mood == "happy") {
  print("Yay! I'm glad you're happy!")
} else if (mood == "sad") {
  print("I'm sorry to hear that. I hope things get better!")
} else {
  print("Thanks for sharing how you're feeling!")
}
```

The problem with this is the LLM will rarely respond in a structured format. Their response might look something like this, which is hard to write an if statement against:

```
The user's mood based on the message "I am feeling great today!" is positive and upbeat.
```

People soon figured out that you could specify in the prompt what format you wanted to return:

```
const mood = llm("What is the user's mood based on this message: 'I am feeling great today!'? Return just one word: happy, sad, or neutral.")
```

This technique often works, but not always. So API started providing a structured response parameter. You can set your desired structured response and the API will do its best to match that structure.

The structured response needs to be specified as a JSON schema. Here's what the JSON schema would look like in this case:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "string",
  "enum": ["happy", "sad", "neutral"]
}
```

JSON schemas get pretty verbose. Agency lets you specify the structured response format as a type definition instead.

```ts
type Mood = "happy" | "sad" | "neutral"
const mood: Mood = llm("What is the user's mood based on this message: 'I am feeling great today!'?")
```

Just add a type hint to your variable and that will automatically get compiled as a JSON schema and sent as the structured response format to the LLM.

## Tools

We also quickly figured out that it's very useful if an LLM can call a function automatically. This allows them to actually *do* stuff instead of just returning text. Tool calling is just a special kind of structured response.

When you make that API call, you send a list of tools with it. These tools are specified as JSON schemas. You specify the inputs and outputs for the tool, as well as a description. Here's the JSON schema for a simple add function, for example:

```json
{
  "name": "add",
  "description": "adds two numbers together",
  "parameters": {
    "type": "object",
    "properties": {
      "a": {
        "type": "number",
        "description": "The first number"
      },
      "b": {
        "type": "number",
        "description": "The second number"
      }
    },
    "required": ["a", "b"],
    "additionalProperties": false
  },
  "returns": {
    "type": "number",
    "description": "The sum of the two numbers"
  }
}
```

You don't have to read the whole thing, I just want to show you how long these JSON Schemas can get. A basic add function takes up nearly 25 lines.

If the LLM decided to call this tool, it may return a response that looks like this.

```json
{
  "tool_calls": [
    {
      "id": "call_12345",
      "type": "function",
      "function": {
        "name": "add",
        "arguments": "{\"a\": 2, \"b\": 3}"
      }
    }
  ]
}
```

Notice that it doesn't actually call the tool... it doesn't have access to it. It just tells you what tool it wants you to call. *You* then need to parse this response and call the tool for the LLM. Here is what the pseudocode for that might look like:

```ts
for (const toolCall of response.tool_calls) {
  if (toolCall.function.name == "add") {
    const args = JSON.parse(toolCall.function.arguments)
    const result = add(args.a, args.b)
    // send the result back to the LLM in a new message
  }
}
```

I'm showing you this so you can see how manual this flow is. You need to call the function yourself and then send the response back to the LLM. The response could look something like this.

```json
{
  "role": "tool",
  "tool_call_id": "call_12345",
  "name": "add",
  "content": "5"
}
```

> Note: There is a lot of discussion online about unsafe behavior from LLMs, so I want to show you this so you understand that at no point does an LLM have direct access to a function. A programmer needs to write the code to call the function. If the programmer decides to not write that code, then the LLM can't call the function. All it can do is return text. If you don't want an LLM to delete your production database, just don't write the code that deletes your production database... it's that simple.

You can see that tool calling is kind of arduous.
1. You need to specify the JSON schema.
2. You need to look for tool calls in the response from the LLM.
3. You need to call all the related functions.
4. You need to send that result back to the LLM and get another response from it.

It's a lot of manual work. And a language like TypeScript doesn't have any special features for JSON schemas, so you need to define your function and your JSON schema separately and make sure that they don't get out of sync.

It's a lot of manual work for something that is a basic feature of agents.

### Tool calling with Agency

Agency makes tool calling much simpler. You define your function:

```ts
def add(a: number, b: number): number {
  """
  Adds two numbers together.
  """
  return a + b
}
```

Then you can just pass that function directly to the LLM:

```ts
const response = llm("What is 2 + 3?", tools: [add])
```

Agency takes care of creating the JSON schema for you, looking for any tool calls, calling the tool, sending the response back to the LLM, and getting a response back. The whole process is much more intuitive, I think.

As a side note, Agency has a lot of functionality for making tool calls safer, such as interrupts and PFAs. We'll discuss these later in the guide.

## A loop

The last piece of an agent is a loop. You give an LLM a task to work on. Then you run your LLM call with some tools in a loop until the LLM decides it's finished working on the task. This is the hallmark of agents: that they decide for themselves when they are done working on a task.

Here's an example of an agent with tools and a loop. You can see we're using structured outputs so the agent can tell us when it's done working on this task.

```ts
type Response = {
  message: string
  action: "question" | "done"
}

let response: Response = { message: "", action: "question" }

const prompt = "Help me organize my files. First look through all of them and categorize them. Then present me with the files, one category at a time, and let me say whether I want to keep them or delete them."

let response: Response = llm(prompt, tools: [read, write])

while (response.action != "done") {
  print(response.message)
  userResponse = input("What's your response? ")
  response = llm(userResponse, tools: [read, write])
}
```

Writing an agent is nearly this simple in Agency. You need to learn about a couple Agency concepts first: [nodes](./nodes), [interrupts](./interrupts), and [handlers](./handlers). Remember how I said earlier that Agency lets agents use these tools safely? Interrupts and handlers are one way to add safety and make sure the agent doesn't read any files you don't want it to read. This is an important concept we'll cover later in the guide, and then you'll be able to write an agent to do this task.

## Conclusion
So that is what an agent is: an LLM call, some tools, and a loop. Agency makes it very easy to write agents. Lets dive into it!