# Capabilities

A function can say what the machine running the program must be able to do for it to work. That is the `@capabilities` tag:

```
@capabilities(fileRead)
export def exists(path: string): boolean {
  return _exists(path)
}
```

The names come from a fixed list of seven: `fileRead`, `fileWrite`, `network`, `subprocess`, `env`, `terminal`, and `llm`. Each one is a part of the host, the layer between a program and the platform it runs on, and a platform may lack some of them. A browser, for example, has no files to read, so it has no `fileRead`. A function that needs two things names both, `@capabilities(fileRead, subprocess)`. A node takes the tag the same way.

A function with no tag declares nothing of its own. What it needs is what the functions it calls need, so a wrapper needs no tag:

```
def hasNotes(): boolean {
  return exists("notes.txt")    // needs fileRead, through exists
}
```

Every function in the standard library that touches the host carries the tag, so your own code only needs one when it calls into a TypeScript file of yours that reaches the file system, the network, or a process directly. Put the tag on the Agency function that calls it. The tag goes on a `def` or a `node` and nowhere else; a tag above an `effect` declaration is an error that says to move it to the function that raises the effect.

The tag does two things:

- **Compiling for a platform.** `agency compile --platform browser app.agency` (or `"platform": "browser"` in `agency.json`) fails if any node or exported function needs a capability the browser lacks, and tells you how the node gets there:

  ```
  error AG3029: Node 'main' needs the fileRead capability, which the browser platform does not have.
    main calls loadNotes (notes.agency:12)
    loadNotes calls read from std::index (notes.agency:4), which needs fileRead
  ```

  The default platform is `node`, which has every capability, so nothing changes until you ask for another.

- **Refusing before anyone is asked.** When a program runs on a host that lacks a capability, a function that needs it is refused the moment it is called, before its body runs, before any handler runs, and before a person is asked to approve anything. The call returns a failure:

  ```
  exists needs the fileRead capability, which the browser host does not have. No tool call can supply it.
  ```

  A model that called the function as a tool sees the same text, and the last sentence tells it not to try again with other arguments.

Capabilities add to handlers and policies and replace neither:

| | Effects, policies, handlers | Capabilities |
| --- | --- | --- |
| Question | May this action happen? | Can this host do it at all? |
| Detail | This file, this command | Seven names |
| Who answers | A handler, a policy, or a person | Nobody. It is fixed when the host is built. |
| Can the program approve it | Yes, with `with approve` | No |

A file read wrapped in `with approve` is still refused on a browser, because approving it would not make the browser able to read the file.

One thing the compile-time check does not look at: code at the top of a file, outside any function, such as a `static const` whose initializer calls a TypeScript helper directly. There is no function to carry a tag there. The host still refuses it when the module loads. Wrap the call in a tagged `def` if you want the compiler to see it.
