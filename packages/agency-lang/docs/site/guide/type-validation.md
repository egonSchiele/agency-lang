---
name: Type Validation
description: Describes the `@validate` and related annotations that let you attach arbitrary validation logic to types, used by the bang (`!`) operator and other runtime validators.
---

# Type Validation

Agency allows users to add an arbitrary validation logic on types. Remember that with [schemas](/guide/schemas), you could validate a type with the bang operator: `Person!`. You can also write custom validation that runs for any type. This validation also gets triggered when you validate using the bang operator.

## `@validate`

Simple example:

```ts
type Person = {
  name: string;

  @validate(isPositive)
  age: number;
}
```

The `isPositive` function then returns a `success` or `failure`.

```ts
def isPositive(value: number): Result<number> {
  if (value > 0) {
    return success(value);
  }
  return failure("expected ${value} to be > 0")
}
```

If successful, the function returns `success` with the value. You can also send a new value to modify the value. So for example, instead of having isPositive fail, we could just have it clamp the value to be above zero.

```ts
def isPositive(value: number): Result<number> {
  if (value > 0) {
    return success(value);
  }
  // always succeeds, modifies value
  return success(1);
}
```

That's all you need. Now when someone tries to validate an object of type `Person`, your validation will run. Example:

```ts
const person: Person! = { name: "Alice", age: -5 }
// person is now failure("expected -5 to be > 0")

const person: Person! = { name: "Alice", age: 38 }
// person is now success({ name: "Alice", age: 38 })

// With the validator that modifies the value, instead of failing:
const person: Person! = { name: "Alice", age: -5 }
// person is now success({ name: "Alice", age: 1 })
```

## Creating a reusable type with validation

In our example, we set the validator on the key in the `Person` type. We could also create a new type instead.

```ts
@validate(isPositive)
type Age = number;

type Person = {
  name: string;
  age: Age;
}
```

This is nice because it lets you create a type that has validation built in, that you can now use everywhere (see [`std::validation`](/stdlib/validation)). This becomes especially useful combined with the `jsonSchema` tag. Let's look at that next.

## `@jsonSchema`
Types are also used as JSON schemas to specify a structured output format to an LLM. When adding validation to a type, you may additionally want to tell the LLM about it. For example, if you've just added validation saying that age must be positive, you might want to give the LLM a hint that the number should be greater than zero. You can do this using the jsonSchema tag:

```ts
@validate(isPositive)
@jsonSchema({ minimum: 1 })
type Age = number;
```

`jsonSchema` takes an object, and all of the fields here are simply passed as additional fields to the [JSON schema object that is constructed](https://json-schema.org/understanding-json-schema/reference/object).

Obviously, to do this correctly, you'll need to know the correct fields to pass to the JSON schema. I have some references at the end of this writeup for this.

If you're not sure what JSON schema field to use, you can always just put some information in the description field:

```ts
@validate(isPositive)
@jsonSchema({ description: "should be > 0" })
type Age = number;
```

Used together, these two tags let you create new types that have custom validation and also have the right JSON schema hints. The agency standard library already comes with some of these types built in (see [`std::validation`](/stdlib/validation)).

## Sidebar: Inspecting the JSON schema
If you're not sure what the result in JSON schema is going to look like, you can always print it out in Agency:

```ts
const personSchema = schema(Person)
print(personSchema.zodSchema.toJSONSchema())
```

## Multiple validators and schemas

You can set multiple validators, and they will all run in order. If you transform the value, the transformed value will get handed to the next validator:

```ts
@validate(isPositive, isAdult)
type AdultAge = number;
```

If any of the validators fails, the chain stops and returns a failure.

You can also stack `@validate` tags:

```ts
@validate(isPositive)
@validate(isAdult)
type AdultAge = number;
```

The same behavior also works for the `jsonSchema` tag, but obviously, while you can have multiple validators, in the end, you're only going to produce a single JSON schema tag. So if you specify multiple objects, later objects may override the keys in earlier objects:

```ts
@jsonSchema({ foo: 1, minimum: 1 })
@jsonSchema({ bar: 1, minimum: 18 })
type Age = number; // schema includes { foo: 1, bar: 1, minimum: 18 }
```

The one exception to this is the `description` field. Descriptions all get concatenated together, separated by new lines. This lets you create reusable types, and set a description in the description field, and know that that description will get passed down.

## Container types, recursive types
Here is an array of ages.

```ts
type Ages = Age[]
```

Remember that `Age` has validation built in. When you validate an array of ages, each element will get validated separately. If any of them fails, *the entire array* will fail validation. 

```ts
const ages: Age[]! = [-1, 2, 3]
print(ages) // failure('expected -1 to be > 0')
```

You could also add a second validator that runs for the entire array.

```ts
@validate(nonEmpty)
type Ages = Age[]
```

Similar situation for objects:

```ts
@validate(noNullFields)
type Person = {
  name: string;
  age: Age;
}
```

Similar situation for recursive types, although currently we hard code the recursion depth to prevent infinite recursion during validation.

## JS Validators

You don't need to write your validation function in agency. You can write it in TypeScript if you want.

```ts
import { success, failure } from "agency-lang/runtime";

export function isPalindrome(value) {
  const reversed = value.split("").reverse().join("");
  return value === reversed
    ? success(value)
    : failure("not a palindrome");
}
```

## References
- [minimum](https://json-schema.org/draft/2020-12/draft-bhutton-json-schema-validation-00#rfc.section.6.2.4)
- [JSON Schema object](https://json-schema.org/understanding-json-schema/reference/object)
- [OpenAI docs](https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas)