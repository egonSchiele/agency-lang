When you create a thread, you can capture all messages in that thread by assigning to a variable:

```ts
node threadExample() {
  msgs = thread {
    res1: number[] = llm("What are the first 5 prime numbers?")
    res2: number[] = llm("What are the next 2 prime numbers after those?")
    res3: number = llm("And what is the sum of all those numbers combined?")
  }
  return msgs
}
```

`msgs` is now:

```ts
[
  {
    "role": "user",
    "content": "What are the first 5 prime numbers?"
  },
  {
    "role": "assistant",
    "content": "{\"response\":[2,3,5,7,11]}"
  },
  {
    "role": "user",
    "content": "What are the next 2 prime numbers after those?"
  },
  {
    "role": "assistant",
    "content": "{\"response\":[13,17]}"
  },
  {
    "role": "user",
    "content": "And what is the sum of all those numbers combined?"
  },
  {
    "role": "assistant",
    "content": "{\"response\":68}"
  }
]
```

An example with subthreads:

```ts
node threadExample() {
  msgs = thread {
    res1: number[] = llm("What are the first 5 prime numbers?")
    res2: number[] = llm("What are the next 2 prime numbers after those?")
    msgs2 = subthread {
      res3: number = llm("And what is the sum of all those numbers combined?")
    }
    msgs3 = subthread {
      res4: number = llm("What are the next 3 after that?")
    }
  }
}
```

`msgs` is:

```ts
[
  {
    "role": "user",
    "content": "What are the first 5 prime numbers?"
  },
  {
    "role": "assistant",
    "content": "{\"response\":[2,3,5,7,11]}"
  },
  {
    "role": "user",
    "content": "What are the next 2 prime numbers after those?"
  },
  {
    "role": "assistant",
    "content": "{\"response\":[13,17]}"
  }
]
```

`msgs2` is:
```ts
[
  {
    "role": "user",
    "content": "What are the first 5 prime numbers?"
  },
  {
    "role": "assistant",
    "content": "{\"response\":[2,3,5,7,11]}"
  },
  {
    "role": "user",
    "content": "What are the next 2 prime numbers after those?"
  },
  {
    "role": "assistant",
    "content": "{\"response\":[13,17]}"
  },
  {
    "role": "user",
    "content": "And what is the sum of all those numbers combined?"
  },
  {
    "role": "assistant",
    "content": "{\"response\":68}"
  }
]
```

`msgs3` is:

```ts
[
  {
    "role": "user",
    "content": "What are the first 5 prime numbers?"
  },
  {
    "role": "assistant",
    "content": "{\"response\":[2,3,5,7,11]}"
  },
  {
    "role": "user",
    "content": "What are the next 2 prime numbers after those?"
  },
  {
    "role": "assistant",
    "content": "{\"response\":[13,17]}"
  },
  {
    "role": "user",
    "content": "What are the next 3 after that?"
  },
  {
    "role": "assistant",
    "content": "{\"response\":[19,23,29]}"
  }
]
```