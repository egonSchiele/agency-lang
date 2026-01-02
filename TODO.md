- comments at the end of lines don't work right now. example: `foo = 1 // this is a comment`
- objects don't support `obj[key]` syntax yet, just `obj.key`

can't have nested match blocks, eg:

```adl

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

```adl
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

Fuck, params in functions don't work right now?!