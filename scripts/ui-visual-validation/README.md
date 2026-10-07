# Electron UI visual validation

Run `npm run harness:ui:preflight`, `npm run harness:ui:test` or `npm run harness:ui:scenario -- continuum`.
Requires the repository's installed Electron. No personal profile, credentials, CUA or Playwright are used.
Each invocation creates its own temporary Chromium profile and removes it after process termination.
Evidence remains in ignored `.code-awareness/visual-validation/<run-id>/`: lossless PNG, compact runtime log and receipt.json.
The receipt records status, stable failure reason, runtime, checks, captures, dimensions and cleanup.

A scenario is a CommonJS module in `scenarios/` exporting `async run(ctx)`.
It owns explicit fixtures, page preparation, selectors, states and feature assertions.
`ctx` supplies temporary/project/evidence paths, the isolated BrowserWindow, `load(file)`,
`evaluate(fn, ...serializableArgs)`, `waitFor(fn, ...args)`, native `click(selector)`,
`input(selector, text)`, `viewport(width, height)`, `capture(name)`, `overflow()` and `check(name, passed)`.
Functions evaluated in Chromium cannot close over Node variables. Capture names are safe filename stems.
Waits have a five-second condition deadline; the parent enforces a whole-scenario deadline and process teardown.

Inspect screenshots before approving visual evidence. A generated PNG alone is not visual acceptance.
These scenarios prove real Chromium rendering and the exercised interactions, not backend, persistence or remote integration contracts.
The Continuum scenario renders the actual product component and styles with explicitly synthetic read API fixtures.
Scenarios remain opt-in; they are not added to the global validation gate.
