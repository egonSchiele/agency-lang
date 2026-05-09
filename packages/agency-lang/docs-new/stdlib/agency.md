# agency

## Types

### CompiledProgram

```ts
type CompiledProgram = {
  moduleId: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agency.agency#L3))

## Functions

### compile

```ts
compile(source: string): Result
```

Compile Agency source code. Returns a CompiledProgram on success, or a failure with compilation errors. Only standard library (std::) imports are allowed in the compiled code.
  @param source - Agency source code as a string

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agency.agency#L7))

### run

```ts
run(compiled: CompiledProgram, options: { node: string; args: Record<string, any> }): Result
```

Execute a compiled Agency program in a subprocess. The parent's handler chain extends to the subprocess — subprocess interrupts must be approved by both subprocess and parent handlers. Returns the subprocess node's result on success.
  @param compiled - A CompiledProgram from compile()
  @param options - Which node to run and what arguments to pass

**Parameters:**

| Name | Type | Default |
|---|---|---|
| compiled | [CompiledProgram](#compiledprogram) |  |
| options | `{ node: string; args: Record<string, any> }` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agency.agency#L15))
