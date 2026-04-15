# Functions
All functions can be used as tools. More on this in the [chapter on LLMs](./llm). Functions can take a docstring, and this will be sent to the LLM as a description of the tool. You can have default arguments...

```ts
def round(num:number, decimals:number = 2)
```


...and variadic arguments

```ts
def print(...messages:string[])
```


Functions also support [block syntax](./blocks).

You can also use named parameters in function calls.

```ts
def round(num:number, decimals:number = 2) {
  // body
}

round(num: 3.1415, decimals: 3)
```

These don't let you skip any parameters, but do make your code clearer and easier to read.