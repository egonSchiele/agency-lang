[View source](https://github.com/egonSchiele/agency-lang/blob/main/packages/agency-lang/examples/spawn.agency)

A small example of `spawn` and `agency attach`.

   pnpm run agency run foo.agency

 `main` starts the `worker` node of this same file as a separate process
 and exits. The worker wants to write a file, nobody has approved that, so
 it waits. Attach to it with the pid `main` prints, and answer:

   pnpm run agency attach pid

```ts
import { spawn } from "std::agency"

node main() {
```

`with approve` approves starting the worker. It approves nothing the
   worker does once it is running.

```ts
  const started = spawn(
    ".",
    "foo.agency",
    node: "worker",
    name: "foo-worker",
    outputFile: "./foo-worker.log",
  ) with approve
  if (isSuccess(started)) {
    const process = started.value
    print("Started ${process.name} as pid ${process.pid}.")
    print("Its output goes to ${process.outputFile}")
    print("To answer its question, run: pnpm run agency attach ${process.pid}")
  } else if (isFailure(started)) {
    const err = started.error
    print("Could not start the worker: ${err}")
  }
}

node worker() {
  print("Worker: started.")
  print("Worker: about to write foo-output.txt, which needs an approval.")
  const result = write("foo-output.txt", "written by the worker\n", ".")
  if (isFailure(result)) {
    print("Worker: the write was rejected.")
  } else {
    print("Worker: wrote foo-output.txt.")
  }
  print("Worker: done.")
}
```
