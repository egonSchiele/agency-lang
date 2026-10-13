# Capabilities

An effect declaration can say what the machine running the program must be able to do for the effect's function to work. That is the `@capabilities` tag:

```
@capabilities(fileRead)
effect std::read {
  dir: string,
  filename: string
}
```

The names come from a fixed list of seven: `fileRead`, `fileWrite`, `network`, `subprocess`, `env`, `terminal`, and `llm`. Each one is a part of the host, the layer between a program and the platform it runs on, and a platform may lack some of them. A browser, for example, has no files to read, so it has no `fileRead`. An effect that needs two things names both, `@capabilities(fileRead, subprocess)`; an effect that needs nothing writes `@capabilities()`; and an effect with no tag at all needs nothing, which is right for an effect you declare and raise in your own code. Every effect in the standard library carries the tag.

The tag does two things:

- **Compiling for a platform.** `agency compile --platform browser app.agency` (or `"platform": "browser"` in `agency.json`) fails if any node or exported function can raise an effect that needs a capability the browser lacks, and tells you how the node gets there:

  ```
  error AG3029: Node 'main' raises 'std::read', which needs the fileRead capability. The browser platform does not have it.
    main calls loadNotes (notes.agency:12)
    loadNotes calls read from std::index (notes.agency:4), which raises std::read
  ```

  The default platform is `node`, which has every capability, so nothing changes until you ask for another. A module that only works on Node for a reason other than its effects, such as `std::ui`, which drives a terminal in raw mode, is reported when the program is bundled for the browser.

- **Refusing before anyone is asked.** When a program runs on a host that lacks a capability, a raise of an effect that needs it is rejected on the spot, before any handler runs and before a person is asked to approve it. The function sees the same failure a rejected interrupt gives, with a message like `std::read needs the fileRead capability, which the browser host does not have.`

Capabilities add to handlers and policies and replace neither:

| | Effects, policies, handlers | Capabilities |
| --- | --- | --- |
| Question | May this action happen? | Can this host do it at all? |
| Detail | This file, this command | Seven names |
| Who answers | A handler, a policy, or a person | Nobody. It is fixed when the host is built. |
| Can the program approve it | Yes, with `with approve` | No |

A file read wrapped in `with approve` is still refused on a browser, because approving it would not make the browser able to read the file.

