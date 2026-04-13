# fork
`fork` is a powerful built-in. It allows you to run multiple threads in parallel and collect all their results. Here is an example program to help find a gift for someone on Etsy.

```ts
node main() {
  const giftIdea = input("Tell me about a person you want to get a gift for: ")
  const prompt = """
    This person is looking for a gift for a special someone. Based on the gift recipient's description and interests, please suggest some keyword searches on Etsy for finding them a gift. The gift recipient is: ${giftIdea}
    """
  const searches: string[] = llm(prompt)
  const results = fork(searches) as search {
    print("Searching for ${search}...")
  }
  print("Here are some gift ideas based on your description:")
  print(results)
}
```

The way it works is:

1. Asks for details about the gift recipient
2. Uses an LLM to generate keyword searches
3. Runs each keyword search in parallel and collects the results.

What makes `fork` really powerful is that each of these threads gets isolated execution state. That means that in each thread you can do whatever you want with the state, and not worry about it conflicting with any other thread. You can also nest `fork`s inside other `fork`s. This can be a powerful way to run multiple LLM calls in parallel to explore a problem space and pick which direction you want to go in.