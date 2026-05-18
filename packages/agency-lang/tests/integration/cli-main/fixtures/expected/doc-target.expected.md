# doc-target

Helpers used by CLI integration tests.

## Types

### Person

A person to greet.

```ts
/** A person to greet. */
type Person = {
  name: string
}
```

## Functions

### greet

```ts
greet(person: Person): string
```

Build a greeting.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| person | `Person` |  |

**Returns:** `string`

## Nodes

### main

```ts
main(): string
```

Return a greeting for Ada.

**Returns:** `string`
