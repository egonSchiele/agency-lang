// Agency namespaces with `::`, so a heading like `std::notes::create`
// contains the substring `:notes:` — which markdown-it-emoji, enabled
// unconditionally by VitePress, rewrites to 🎶 (GitHub issue 843). No
// page here uses emoji shortcodes on purpose, so the plugin only ever
// costs us. The `true` is markdown-it's ignoreInvalid flag: if a later
// VitePress stops registering the rule, the build still works.
md.core.ruler.disable("emoji", true);
