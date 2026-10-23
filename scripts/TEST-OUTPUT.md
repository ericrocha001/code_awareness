# Local test output

Vitest discovery is relative to the selected checkout root and limited to the existing
`src`, `infra`, `docs` and `scripts` trees. The shared lane registry excludes
`.code-awareness` evidence storage at every depth. Native, Git Heavy and benchmark
suite lists and lane-specific exclusions remain authoritative. A child Worktree
selected as its own execution root can collect its own tests normally.
`npm run test:lanes:guard:test` checks this boundary with real Vitest collection,
without executing the fixture test or benchmark bodies.

The existing Node/Vitest, Electron, database, Git and UI npm entrypoints use
`test-output.cjs` to capture full stdout/stderr in `.code-awareness/test-output/<id>`.
Nested wrappers inherit the outer capture; tests, assertions and runner flags remain
unchanged. Interactive `npm test` and Electron watch mode retain conventional output.

For a composite validation or another local command, use:

```powershell
npm run test:agent -- npm run test:native
npm run test:agent -- node scripts/local-agent/e2e.cjs
node scripts/test-output.cjs run --timeout-ms 60000 -- node some-test.cjs
```

Completion produces one receipt projection, no progress snapshots. Limits are UTF-8
bytes: 900 for success and 3500 for failure (presentation proxies, not measured tokens
or billed cost). The persisted receipt records exact command, cwd, pid, duration,
exit, signal and state. Vitest counts are included only when its summary provides them.
`processState` preserves the process outcome separately from `validation`. Vitest CLI
commands and observed `Tests` summaries activate the evidence gate; use
`run --expect-tests -- ...` for other test commands whose summaries may be absent.
Recognized summaries with passed tests produce `SUFFICIENT`; a run with zero executed
tests produces `INSUFFICIENT`. Missing or unrecognized counts produce `UNKNOWN`.
Both states prevent `PASS` and return a nonzero wrapper exit while preserving the
child's exit code. Mixed passed/skipped tests remain sufficient; each observed test
run in a composed command must execute tests. This gate proves execution, not that
every required property or individual test was covered. Generic commands without a
test expectation report process success with validation `NOT_APPLICABLE`.
Failure diagnostics are bounded and deduplicated; full evidence is never truncated.

```powershell
node scripts/test-output.cjs inspect <id> --stream stderr --pattern "Error" --lines 12
node scripts/test-output.cjs inspect <id> --stream stdout --from 100 --lines 20
node scripts/test-output.cjs observe <id> --after-state RUNNING
node scripts/test-output.cjs observe <id> --after-state PASS
```

Observe waits for file events up to 30 seconds and returns only completion or its own
deadline. A repeated terminal state produces no output. Always use the id from the
current execution; a new run cannot update an old observation. Tool sessions should
wait for completion with a bounded output budget, using spaced waits when necessary.
No second observation channel is needed. A runner deadline or cancellation terminates
the child process tree and remains a failure. External termination of the adapter
itself may leave a RUNNING receipt; that receipt is not proof of success.

Use `run --human -- ...` for conventional live output. Direct runner invocations,
`--human`, interactive watch mode and arbitrary shell commands remain outside the
technical presentation bound. For a composite npm script, outer `test:agent` also
captures npm banners and prerequisite output.

Logs may contain secrets: they are git-ignored, use owner permissions on Unix and an
explicit user-only directory ACL on Windows. They are retained until explicitly
released; `clean <id>` removes only that completed execution after the evidence is
no longer required. There is no automatic expiry of proofs. Hard-killed RUNNING
receipts require manual review before cleanup.
