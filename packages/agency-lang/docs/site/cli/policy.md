# Policies

*work in progress*

See the [policies guide](/guide/policies) for what policies are and how they're used at runtime. This page covers the CLI tools for managing them.

## Generating a policy

```
agency policy gen foo.agency
```

Analyzes the Agency file and generates an interrupt policy for it. The generated policy lists the interrupts the agent can produce, with sensible defaults that you can then tweak by hand.

### Options

- `-o, --output <path>` — output path for the generated policy file. Defaults to `policy.json`.
- `-p, --existing <path>` — path to an existing policy file to extend. New interrupt kinds discovered in the file are merged in; existing rules are preserved.
