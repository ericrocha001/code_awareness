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

## Shared UI primitives (opt-in)

`npm run harness:ui:scenario -- ui-primitives` renders the real `Button`, `ContextHelp`
and `SelectField`, shared production CSS and explicitly synthetic content. It exercises
native keyboard selection, help focus/Tab/Escape/outside click, selected/disabled/named
actions, danger hover, dark/light, narrow layouts and contrast of central controls.
It records source HEAD/branch/dirty state at start, isolated-profile cleanup and named
captures. No product route, application API or personal repository data is involved.

For a future visual delivery: recover the canonical Design System and use Academy
`otimizacao-de-ui`; run `ui:acceptance` on the relevant explicit scope; capture the
smallest states that discriminate the actual change in this Harness; **inspect the
images** and correct material divergences. Use an approved reference/comparator only
when such a reference really exists. A fixture proves its stated renderer contracts,
not application backend integration or user approval.

In the Handoff, distinguish mechanical/interaction PASS, capture receipt, actual visual
judgment and any [agent judgment evaluation](../ui-quality/agent-evals.md). Cite run,
source/dirty state, theme/viewport and inspected captures; state uncovered integration
or approval explicitly. Classify a material failure/risk as Design System,
`otimizacao-de-ui`, primitive, guardrail or visual proof, and route a reusable cause
through Academy `harness-improvement`. Do not add a rule or expand feature scope for
every defect. The Design System remains the visual norm; this is the evidence path.

## Native Windows Open/Save (opt-in)

`native-dialogs` is a real Electron Main/Windows acceptance scenario:
`npm run harness:ui:scenario -- native-dialogs --timeout-ms 90000`. It requires an interactive Windows
desktop, Windows PowerShell and UI Automation. Unsupported environments fail explicitly;
they never produce simulated acceptance. No administrator privileges are required.

A scenario opts in by exporting `nativeDialogs = { fixtures: [{ name: 'input.md',
type: 'OPEN' }, { name: 'output.md', type: 'SAVE' }] }`. Only predefined local basenames
with `.md`, `.txt`, `.webp` or `.zip` extensions are accepted. Use
`ctx.nativeDialogs.fixture(name)` to prepare a fixture in the execution's temporary
sandbox. Links/junctions, traversal, network paths, alternate streams, unknown names
and existing Save destinations are rejected. Fixtures are removed with the isolated
profile; copy relevant hashes/proofs to the evidence directory before teardown.

In Main, call `await ctx.nativeDialogs.run({ type: 'OPEN', fixture: 'input.md' },
() => dialog.showOpenDialog(ctx.window, { properties: ['openFile'] }))`.
Use `type: 'SAVE'` with `dialog.showSaveDialog`, or `action: 'CANCEL'` to cancel either
flow. The callback must return the actual Electron dialog promise. The controller
compares its canceled/filePaths/filePath result with the declared operation and fixture.
Defaults are `action: 'CONFIRM'` and an eight-second dialog deadline; `timeout` is bounded
to 500–15000 ms, with five additional seconds for helper startup/shutdown. Operations
on a controller are sequential. Pending operations are abandoned during disposal.

Only opt-in scenarios reveal their isolated owner via `showInactive()`. PID and native
HWND are captured in Main. The helper enumerates only that process's thread windows,
requires a unique visible `#32770` with the exact owner HWND, and rechecks ownership
before mutation. UIA Value/Invoke patterns are preferred; known Win32 control IDs
1001 or classic edt1/1148, and buttons 1/2, cover the observed Common Dialog variants.
Cancel uses the validated Win32 button because UIA Invoke returned without dismissing
the real Windows dialog in acceptance. Confirm prefers UIA when its patterns and native
control identity are available. Labels, titles and screen
coordinates are not selectors. Structured UTF-8 stdin transports arguments without
shell interpolation. Receipts record PID/owner/dialog, method, operation, ownership,
actual result and helper termination, excluding fixture contents, paths and UI labels.

Failures distinguish `UNSUPPORTED_PLATFORM`, `DIALOG_NOT_FOUND`, `OWNER_MISMATCH`,
`CONTROL_UNAVAILABLE`, `DIALOG_TIMEOUT`, `CANCEL_FAILED` and `HELPER_FAILED`.
Disposal stops tracked helpers and destroys only this worker's Electron windows;
the parent deadline kills the worker process tree and verifies sandbox removal.
`--timeout-ms` explicitly overrides the usual 30000 ms scenario deadline, up to 120000 ms;
the native acceptance scenario uses 90000 ms to cover its positive and negative flows.
Renderer `click`/`input`, hidden captures, comparison and HTML file chooser interception
retain their existing behavior. This API does not operate arbitrary desktop windows.

Directed regressions: `node --test scripts/ui-visual-validation/native-dialogs.test.cjs`.
The Windows ownership test is explicitly skipped elsewhere; that skip is not native
runtime proof. Run the native scenario plus the existing preflight/comparator regressions
for Windows acceptance.

## Approved reference comparison (opt-in)

Compare an explicitly selected approved PNG with a user-supplied application screenshot,
without starting Electron or any scenario:

```powershell
npm run harness:ui:compare -- --reference "C:\review\approved.png" --reference-approved --actual "C:\review\application.png" --origin USER_RUNTIME_SCREENSHOT
```

`--reference-approved` records the caller's declaration of human approval. File presence
does not imply approval. `--origin USER_RUNTIME_SCREENSHOT` explicitly declares an external
application screenshot; it is not independent authentication of its source. The command
does not capture the personal desktop, access profiles or credentials, or use the network.
The optional `--mode both` selects the supported side-by-side plus overlay package (the
default); other modes are rejected.

Optionally supply `--metadata "C:\review\pair.json"` with known information for each input:

```json
{
  "reference": { "viewport": { "width": 1672, "height": 941 }, "scale": 1, "theme": "dark" },
  "actual": { "viewport": { "width": 1672, "height": 941 }, "scale": 1, "theme": "dark", "gitRevision": "known-source-sha" }
}
```

Viewport dimensions are CSS pixels; scale is PNG pixels per CSS pixel. A known viewport
also permits deriving scale from the image dimensions. Missing information stays unknown
with an explicit limitation; equal pixel dimensions alone cannot prove equivalent viewport
regions. User-provided runtime/revision metadata is declared evidence, not a runtime probe.
Different PNG dimensions, incompatible known viewport/scale, or different known themes
produce an error. There is no implicit crop, alignment, rotation or resize. Export equivalent
viewport regions explicitly before comparing if either source includes extra chrome.

To acquire a named capture and then compare it in one invocation of the existing runner:

```powershell
npm run harness:ui:scenario -- git-atlas-mockup --reference "C:\review\approved.png" --reference-approved --capture mockup-wide-dark --metadata "C:\review\pair.json"
```

This runs only the selected scenario. It requires the usual installed Electron binary and
native dependencies prepared for that checkout. It is a separate runtime action, to be
executed only when authorized and within the available quota. Reference path/header and
argument errors are rejected before starting Electron. A comparison uses only a named
capture from a successful run and checks its acquisition SHA-256. Capture viewport, theme,
runtime and checkout HEAD come from the runner, overriding `actual` metadata. Source Git
metadata is a timestamped observation at scenario start, not continuous source freshness.
The origin is
`HARNESS_FIXTURE_ELECTRON`: production components and synthetic repositories/fixtures in an
isolated renderer, not proof of live application backend or remote integrations.

Each comparison creates its own protected `comparison-<run-id>/` under
`.code-awareness/visual-validation/` (inside the scenario's evidence directory when bridged):

- `side-by-side.png`: reference on the left, actual on the right, at original dimensions.
- `overlay.png`: 50% reference / 50% actual. Both views flatten transparency onto white and
  convert to sRGB for display; original files remain untouched.
- `comparison.json`: input paths relative to this directory (explicit authorized absolute
  paths when on another drive), original-byte SHA-256, dimensions, known geometry/theme,
  origin and available revision/runtime, output hashes, limits and independent gates.

Inputs must be explicitly selected regular local PNGs: at most 64 MiB and 32 megapixels each.
Linked paths/junctions, network paths, alternate streams, animated PNGs and rotated images
are refused. Output names are fixed, created exclusively in a new evidence directory.
Failures produce `state: ERROR` with a reason in the manifest when a safe output directory
can be created; argument or unsafe-output failures are also returned on stderr/stdout.

`CAPTURE_OK` means a valid Electron capture; an external image instead records
`USER_PROVIDED_PNG`. `COMPARISON_READY` / `READY_FOR_REVIEW` means the package was produced,
with exit code zero. The runner preserves its original capture `status` and adds
`comparison`; its CLI exits nonzero if either stage fails. `visualAcceptance` remains
`NOT_REVIEWED`. No command emits `VISUAL_ACCEPTED`, a similarity score or aesthetic PASS/FAIL.
Inspect the original captures, side-by-side and overlay before accepting material decisions
of hierarchy, composition and spatial relationships. Explain legitimate differences from
real data and the Design System; do not require illustrative dates/names/counters to match.
Functional, backend, performance and accessibility acceptance need their own evidence.
These files are disposable local evidence and are not uploaded to Continuum automatically.

The focused comparator regressions can be run with
`node --test scripts/ui-visual-validation/compare.test.cjs`. They use explicitly synthetic
input fixtures, verify the output pixels and original-byte hashes, and exercise only one
truncated PNG, one incompatible viewport/scale pair and one prohibited network path.
Their simulated caller origin/approval is not evidence of a real screenshot or design approval.
Native capture keeps the renderer hidden so that taking a screenshot does not activate
visibility-driven background work. The mockup scenario checks this boundary explicitly.
After fonts and finite animations settle, capture waits for a Chromium compositor
presentation instead of assuming that renderer animation frames or a fixed delay prove
fresh pixels. A missing presentation fails with `PAINT_TIMEOUT` after five seconds.

The bounded `git-atlas-mockup` path now captures `mockup-checkout-dark` and
`mockup-wide-dark` at 1672×941, plus `mockup-drawer-dark` at 800×760, all dark theme.
Its synthetic Git history uses dates relative to acquisition time; hashes and capture time
in the package identify the actual inputs rather than promising identical regenerated data.
It no longer assumes a fixed 90-day axis, independent horizontal track guides or obsolete
toolbar geometry. The legacy temporal-window checks elsewhere in `git-management` and
`git-atlas-grid` are not current Git Atlas acceptance contracts and are not used by this
comparison path; modernizing those broader scenarios is outside this MVP.

## Code Map incremental convergence (Windows, conditional gate)

Select this existing proof by the semantic reach of the diff and affected contracts,
following the canonical `validacao-de-implementacoes` Skill. There is no path/glob
selector or additional validation profile registry in this Harness.

| Decision | Material reach of the change | Required evidence |
| --- | --- | --- |
| `REQUIRED: yes / RUN` | Convergence/indexing, SQLite or Main cost, symbol/relationship resolution, watcher/coalescing, readiness through IPC, or tree remount/refetch during background updates | Run the scenario below and retain its actual result. |
| `REQUIRED: no / NOT_RUN` | Documentation, cosmetic changes, or refactoring demonstrably unable to affect those boundaries | Record a short causal justification; the filename alone is insufficient. |

A documentation example that changes the execution/acceptance contract is not automatically
exempt. Conversely, an unrelated IPC change does not require this Code Map proof merely
because it touches an IPC file. If reach is uncertain, inspect the boundary before deciding.
A required run that is missing, blocked or failed remains a validation gap, never a justified
`NOT_RUN` or PASS. The selection is procedural; no CI or global test hook is added.

Run `node scripts/ui-visual-validation/harness.cjs codemap-convergence --timeout-ms 600000`.

Use the existing receipt to report `REQUIRED/RUN/NOT_RUN`, the reason, actual checkout/HEAD
and working-tree changes, Windows/Electron environment, deadline, latency budget, observed
Main/continuous IPC maxima and result. The runner records source identity at scenario start;
that snapshot is not proof of a clean checkout or a different running application. Scenario
source hashes bind the measured Code Map implementation. Renderer errors, failed navigation,
IPC failures or exceeded IPC budget veto PASS even when the Main is healthy or the batch
finishes. A healthy Main metric alone cannot satisfy this gate.
This scenario uses the production CodeMapView, preload, IPC handlers, CodeMapService,
watcher, extractors and SQLite in a visible Electron window with an isolated profile.
Only project selection and unrelated empty tags are fixture adapters. It does not boot
installation, remote integration or the complete application shell.

The owned fixture contains 1,146 files, approximately 54,000 elements and 48,000
references across 150 importers. It changes a declaration signature, exercises native
file selection and source rendering during convergence, and measures continuous
renderer-origin IPC plus Main event-loop pulses across all phases. The acceptance
budget is 750 ms for both maxima: sub-second interaction while retaining the atomic
high-fanout SQLite commit, with host scheduling margin. This is not a frame-rate SLA.
It also checks a body-only edit, a six-file watcher burst, exact reference identities,
SQLite integrity, durable readiness and two stable reopens without extra projection work.

Initial fixture preparation may exceed the usual two-minute scenario limit; only this
scenario accepts an explicit deadline up to ten minutes. Initial renderer mounting has
a separate 30-second setup deadline; synchronization latency measurements start after
mounting. The fixture is retained in ignored `.code-awareness/codemap-convergence-repository`
for reruns and interruption recovery. Its ownership marker is inside `code_awareness/`.
Runtime receipts, phase metrics, source hashes and screenshots stay in the existing
visual-validation evidence store. They and the fixture are owned reproducibility evidence,
not application profile data; retain them through review and apply the runner's retention policy.
