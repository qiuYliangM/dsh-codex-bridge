# Contributing

Use Node.js 22.19 or newer. Runtime protocol tests and packaging use the vendored transport; the DSH host supplies the declared peer dependencies.

```sh
npm ci --legacy-peer-deps --ignore-scripts
npm test
npm run package
npm run test:package
```

The default tests use temporary homes, mock executables and a local test gateway.
They do not send model prompts or change your normal chats. Real-client integration
tests require explicitly configured executable paths; see the README.

Keep target routing explicit. Do not add a default project/session, silently create
a replacement for a missing target, or report a queued message as a completed task.
Add a regression test when changing delivery, installation or partial-result handling.

Keep runtime data and test reports out of commits. Preserve the vendored library's
license. Do not bundle proprietary clients or their extracted implementation files.
