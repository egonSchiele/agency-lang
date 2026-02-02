- comments at the end of lines don't work right now. example: `foo = 1 // this is a comment`
- objects don't support `obj[key]` syntax yet, just `obj.key`

can't have nested match blocks, eg:

```agency

// Nested match blocks
userRole = "admin"
userStatus = "active"

match(userRole) {
  "admin" => {
    match(userStatus) {
      "active" => print("Active admin user")
      "inactive" => print("Inactive admin user")
    }
  }
  "user" => {
    match(userStatus) {
      "active" => print("Active regular user")
      "inactive" => print("Inactive regular user")
    }
  }
  _ => print("Unknown role")
}
```

This should work, but doesn't because of scoping... all `points` end up in the same scope

```agency
grade = "A"
points = 0
match(grade) {
  "A" => points = 100
  "B" => points = 85
  "C" => points = 70
  "D" => points = 55
  _ => points = 0
}

```


## chained property access doesn't work

foo.bar.baz()

## semicolons
should allow spaces before semicolons

```
        input: '  @model  =  "gpt-4"  ;  ',
```

## parens around types

Can't do this yet:

```

type ListIngredientsParams = {
  includePublicIngredients: boolean;
  attributes: (name | serving_size)[] | undefined
}
```

- no loops
- no else statements
- no infix operators yet (e.g., `+`, `-`, `*`, `/`, `&&`, `||`, `>=`, `<=`, `==`, `!=`, etc.) -- builtin replacements provided
- can't assign to an access expression (e.g., `obj.key = value` doesn't work yet)
- can't interpolate anything except a var name. eg `"hello ${person.name}"` doesn't work because we generate a function with arg named `person.name`, which isn't legal.
- nodes can't support multiple params yet
- match blocks don't support blocks