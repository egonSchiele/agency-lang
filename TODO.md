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
- match blocks don't support blocks

imported tools currently can't be used because to create the array that gets passed into the tool, we rely on knowing the names of the arguments so we can put them in the correct order in the array. One way to solve this would be to export a variable containing the arguments of the tool, import it when `import tool` is used, and use it to construct the array.

- todo in lib/templates/backends/typescriptGenerator/promptFunction.mustache

Settings file so users can pick whether they want verbose output while building, what level of logging they want, and whether they want state log logging. If they don't, generate the code without the state log calls.