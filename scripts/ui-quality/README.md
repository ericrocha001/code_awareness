# Directed UI verification

`npm run ui:check` checks only the canonical files explicitly registered in `check.cjs`.
To opt a new or deliberately changed consumer in, use
`npm run ui:check -- --file src/renderer/src/components/NewView/NewView.tsx` (repeat `--file` for more files).
No renderer scan or implicit Git base is used. Missing files, empty explicit selection,
invalid syntax and unknown arguments fail; directories/globs are not expanded.

TypeScript AST rules fail objectively unnamed icon-only buttons, missing static labels,
invalid literal Button variants/sizes/intents and brand colors assigned directly to
declared operational states (`data-ui-state` or `intent`). Shared named imports,
including aliases, are recognized by their canonical module path. Other wrappers,
namespace imports, CSS classes and computed CSS require review; this is not a general
accessibility analyzer. `aria-labelledby` references need rendered verification.

`ERROR` is mechanical failure with file/line/rule/cause. `REVIEW` preserves uncertainty
for dynamic names, content and styles; it does not claim the control is inaccessible.
`MECHANICAL_PASS` means only no supported static error was found in the listed files.
The output always leaves visual quality `NOT_ASSESSED`.

`npm run ui:acceptance` runs this check and the directed React interaction regressions
for help focus/Escape/outside click, native labelled selection and legacy menu contracts.
`npm run ui:check:test` runs the checker's compliant/violating/ambiguous-scope regressions.
For actual geometry, contrast, states and affordance, run the opt-in `ui-primitives`
scenario in the existing [Electron Harness](../ui-visual-validation/README.md) and inspect
the captures. CSS is evaluated there, not parsed with an ad hoc stylesheet scanner.

Visual identity remains owned by Continuum Design System
`artifact-35fcb807-45fb-42a6-a0e8-eb121847ee39`; composition by Academy `otimizacao-de-ui`.
These commands do not migrate or make tests depend on historical feature files.
