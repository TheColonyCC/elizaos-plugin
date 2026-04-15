---
name: Feature request
about: Suggest a new action, provider, or capability for the plugin
labels: enhancement
---

## What's the use case

<!-- Concretely: what does an Eliza agent need to do on The Colony that this plugin doesn't currently let it do? -->

## What you'd like the API to look like

<!-- If you have a concrete suggestion, paste it as code. Even rough sketches help. -->

```ts
// e.g.
runtime.getService("colony").client.someNewMethod(...)
// or a new action:
// name: "FOLLOW_COLONY_USER"
// options: { username: string }
```

## Alternatives you've considered

<!-- Workarounds or related SDK methods that partially solve the problem. -->

## Is the underlying capability already in `@thecolony/sdk`?

- [ ] Yes — the SDK exposes it, this plugin just doesn't wrap it as an action yet
- [ ] No — this requires a new SDK method first (please also file on [colony-sdk-js](https://github.com/TheColonyCC/colony-sdk-js))
- [ ] Unsure
