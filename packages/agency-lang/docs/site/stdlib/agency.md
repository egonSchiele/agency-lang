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
  @param args - Arguments to pass to the node (defaults to no args)
  @param wallClock - Max wall-clock time before SIGKILL (default 60s, max 1h)
  @param memory - Max V8 heap size (default 512mb, max 4gb)
  @param ipcPayload - Max single IPC message size (default 100mb, max 1gb)
  @param stdout - Max combined stdout+stderr bytes (default 1mb, max 100mb)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| compiled | [CompiledProgram](#compiledprogram) |  |
| node | `string` |  |
| args | `Record<string, any>` | {} |
| wallClock | `number` | 60s |
| memory | `number` | 512mb |
| ipcPayload | `number` | 100mb |
| stdout | `number` | 1mb |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agency.agency#L15))

### runFile

```ts
runFile(dir: string, filename: string, node: string, args: Record<string, any>, wallClock: number, memory: number, ipcPayload: number, stdout: number): Result
```

Compile and execute an Agency file in a subprocess. The file is read from dir/filename and compiled with the same stdlib-only import restrictions as compile() before being handed to run() — so the subprocess code can only call into the Agency standard library, not local files, npm packages, or Node modules.

  The dir argument is the sandbox boundary: filename cannot escape it via absolute paths or .. segments (and symlinks are followed and re-checked). dir is required (no default) so the caller must consciously specify the sandbox.

  Use partial application to bind dir to a sandbox directory once, then pass only filename + node at the call site, e.g. const safeRun = runFile.bind(dir: "/safe/dir").

  Resource limits clamp the subprocess: see run() for the full list of caps.

  @param dir - The sandbox directory. filename is resolved against this and must stay inside it.
  @param filename - The agency file to compile and run, resolved relative to dir
  @param node - Which exported node to run
  @param args - Arguments to pass to the node (defaults to no args)
  @param wallClock - Max wall-clock time before SIGKILL (default 60s, max 1h)
  @param memory - Max V8 heap size (default 512mb, max 4gb)
  @param ipcPayload - Max single IPC message size (default 100mb, max 1gb)
  @param stdout - Max combined stdout+stderr bytes (default 1mb, max 100mb)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |
| filename | `string` |  |
| node | `string` |  |
| args | `Record<string, any>` | {} |
| wallClock | `number` | 60s |
| memory | `number` | 512mb |
| ipcPayload | `number` | 100mb |
| stdout | `number` | 1mb |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agency.agency#L47))
