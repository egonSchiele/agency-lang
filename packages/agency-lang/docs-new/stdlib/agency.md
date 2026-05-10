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
run(compiled: CompiledProgram, node: string, args: Record<string, any>, wallClock: number, memory: number, ipcPayload: number, stdout: number): Result
```

Execute a compiled Agency program in a subprocess. The parent's handler chain extends to the subprocess — subprocess interrupts must be approved by both subprocess and parent handlers. Returns the subprocess node's result on success.

  Resource limits clamp the subprocess: it is killed and a limit_exceeded failure is returned if it exceeds wallClock, memory, ipcPayload, or stdout.

  @param compiled - A CompiledProgram from compile()
  @param node - Which exported node to run
  @param args - Arguments to pass to the node
  @param wallClock - Max wall-clock time before SIGKILL (default 60s, max 1h)
  @param memory - Max V8 heap size (default 512mb, max 4gb)
  @param ipcPayload - Max single IPC message size (default 100mb, max 1gb)
  @param stdout - Max combined stdout+stderr bytes (default 1mb, max 100mb)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| compiled | [CompiledProgram](#compiledprogram) |  |
| node | `string` |  |
| args | `Record<string, any>` |  |
| wallClock | `number` | 60s |
| memory | `number` | 512mb |
| ipcPayload | `number` | 100mb |
| stdout | `number` | 1mb |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agency.agency#L15))
