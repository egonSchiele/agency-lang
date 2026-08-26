Example solution:

```agency
  handle {
    foo()
  } with (data) {
    return match(data.effect) {
      "std::read" => {
        approve()
      }
      "std::write" if (data.dir == ".") => approve()
      "std::write" => reject()
      "std::email" => reject()
    }
  }
```

The ideal solution uses a match statement to handle the different effects that `foo` can raise, as it provides exhaustiveness checking and is more concise than using multiple if statements. Even better if the code uses a guard for the matching of `std::write` to approve it only if `dir == '.'`.

---

Could add another test that checks that Results are unwrapped with match too.

Bad:

```
if (result is success(value)) {
    // value is the unwrapped success value
    print(value)
}

if (result is failure(err)) {
    // err is the error string
    print(err)
}
```

Good:

```
match(result) {
    success(value) => print(value)
    failure(err) => print(err)
}
```

---
