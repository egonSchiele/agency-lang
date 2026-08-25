This needs no render-key bump. Adding `@hidden` to a file changes that
file's source hash, so its page re-renders and contributes a smaller
symbol set; the `linkTargets` re-check then invalidates exactly the pages
whose lookups changed. The cache corrects itself through machinery that
already exists.