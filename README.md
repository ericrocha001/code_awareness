<div align="center">
  <img src="assets/Logo%20Colorida.svg" alt="Code Awareness" width="140" />

# Code Awareness

**Local context and reliability infrastructure for AI-assisted software engineering.**

Give an engineering agent the context it needs, when it needs it — without flooding its context window.

</div>

## Why Code Awareness exists

AI-assisted software development has a context asymmetry.

The environment with the most freedom to reason and plan does not always have enough repository context. The environment with complete repository access may be the one whose execution capacity, quota, or compute budget you want to preserve for implementation.

Code Awareness explores a different architecture: **separate reasoning from expensive execution, then make repository context progressively accessible to the reasoning agent.**

The project started as a desktop utility for collecting and compressing source code before sending it to an AI model. As the codebase grew, that model stopped scaling. The architecture evolved from *delivering context to the AI* to *letting the AI acquire the context it determines it needs*.

The guiding objective is simple:

> **Maximize relevant context per token consumed.**

That means more signal, less noise, and less unnecessary context acquisition.

## Architectural evolution

Code Awareness has evolved through several generations of context delivery:

| Stage | Approach | Goal |
| --- | --- | --- |
| Manual context | Select and copy source code | Give the model repository evidence |
| Compressed context | Repomix-based source compression | Reduce the cost of broad context |
| Structured context | Code Map | Turn the repository into navigable structure |
| On-demand context | CodeScope | Let agents progressively discover, inspect, relate, and read only what they need |
| Persistent context | Continuum | Keep engineering handoffs outside the ephemeral chat window |
| Procedural context | Academy *(direction)* | Make reusable engineering knowledge and Skills available alongside repository context |

The current architecture centers on **Code Map + CodeScope**, with **System Health**, **Runtime Identity**, **Validation Ledger**, and **Continuum** providing diagnostic, evidentiary, and persistence capabilities around that context pipeline.

## CodeScope: progressive repository navigation

CodeScope is the primary agent-facing context layer.

Instead of serializing an entire repository into every interaction, it exposes progressively deeper operations. An agent can begin with repository discovery, inspect relevant files, follow relationships and symbols, and request exact source only when necessary.

The intended navigation pattern is:

```text
discover
  ↓
inspect
  ↓
relationships / references / symbol navigation
  ↓
read exact source
```

This is **progressive disclosure applied to source-code context**.

The implementation includes repository discovery, structural inspection, file relationships, references, symbol dependencies and hierarchy, targeted source reads, MCP transport, and capability-based readiness. Lightweight discovery can become available before every deeper repository representation is ready.

### Pure Signal

CodeScope treats response shape as part of the architecture.

The Context Efficiency Harness measures serialized token and character cost and checks purity invariants such as:

- discovery should not leak source bodies;
- structural inspection should not expose internal AST/storage metadata;
- reference results should contain only the public information required for navigation;
- exact source reads should return the requested targets rather than surrounding repository noise;
- navigation overhead and source-envelope overhead are measured independently.

The goal is not merely to retrieve context. It is to retrieve **the smallest useful representation for the current reasoning step**.

## Code Map: the structural foundation

Code Map builds the repository model that makes targeted navigation possible.

The codebase includes specialized extraction for TypeScript/JavaScript and repository structures, persistent symbol/reference data, architectural relationships, source ranges, signatures, and exact-source addressability. Tree-sitter is used where structural parsing provides materially better signal than plain text.

Code Map is designed as infrastructure rather than a one-shot export: repository knowledge can be reused by higher-level context consumers instead of repeatedly reconstructing the same understanding.

## Reliability around the context pipeline

Giving an agent context is only useful if the system can tell whether that context and its delivery path are trustworthy.

### System Health

System Health models the operational boundaries involved in serving context and keeps diagnostic evidence about them. It distinguishes functional tool outcomes from transport health and supports drill-down across MCP requests, CodeScope execution, and relay delivery.

The objective is **fault localization**: reduce a broad “CodeScope failed” symptom into the smallest operational boundary supported by evidence.

### Runtime Identity

Runtime Identity associates evidence with the runtime/source instance that produced it. This prevents historical success or failure from being silently treated as evidence about a different running version.

### Validation Ledger

The Validation Ledger stores reusable validation proofs with information such as status, producer, scope, source fingerprint, runtime instance, requirements, metrics, and timing.

This allows validation evidence to be queried later instead of automatically paying the cost of reproducing every proof. Evidence can also be classified by freshness relative to the current source/runtime.

Together, these components move the system toward a stronger rule:

> **A result is not trustworthy merely because it was produced; its evidence must still apply to the current system.**

## Continuum: context beyond the chat window

Continuum is an early but functional foundation for durable, project-scoped engineering context.

Its current implementation focuses on **implementation handoffs** between agent sessions. Artifacts are stored per repository in SQLite and include provenance such as repository identity, source fingerprint, Git head, creation time, and SHA-256 content integrity.

Current properties include:

- immutable artifact envelopes;
- content-integrity verification;
- project-scoped SQLite persistence with WAL;
- idempotent ingestion and identity-conflict detection;
- repository isolation;
- offline publication through a project-local inbox;
- read-only retrieval through MCP;
- Markdown fidelity for implementation handoffs.

Continuum should not yet be read as a complete general-purpose agent memory system. It is the working foundation for moving valuable project context out of a single conversation and making it recoverable by future agents.

## Engineering method

Code Awareness is developed alongside an evolving **Agentic Engineering System**: a method for building software with specialized AI roles while preserving architectural control and validation discipline.

The method is separate from the product, but Code Awareness is one of its main proving grounds.

The repository's implementation contract reflects several principles:

- strategic architecture and tactical implementation are separate responsibilities;
- implementation follows an explicit executable plan;
- tactical autonomy is allowed inside architectural boundaries;
- completion means **validated completion**;
- execution follows **implement → verify → correct → verify again → advance**;
- agents acquire context on demand instead of loading information defensively;
- reusable capability gaps discovered during development are captured as improvement opportunities;
- implementation handoffs are persisted through Continuum.

This creates a feedback loop:

```text
real development
    ↓
friction discovered
    ↓
engineering learning
    ↓
method / capability improvement
    ↓
better development infrastructure
    ↓
real development
```

## Validation as architecture

Validation is treated as part of the implementation, not as a final checkbox.

The repository contains dedicated test and validation lanes for areas including:

- Code Map and repository addressability;
- context navigation;
- MCP and relay boundaries;
- System Health diagnostics;
- Runtime Identity;
- Validation Ledger;
- Continuum persistence and artifact integrity;
- native Electron / better-sqlite3 runtime compatibility;
- Git and diff behavior;
- compression;
- UI behavior;
- context-efficiency and serialization invariants.

The project also contains native-runtime preflight/doctor tooling and bundle guards because Electron's Node runtime and native modules such as `better-sqlite3` introduce compatibility boundaries that need explicit validation.

No current pass count is claimed here: this repository is being prepared for public portfolio use from a recovered development state, and the complete Windows validation suite has not been rerun since that recovery.

## Technology

The current codebase is built primarily with:

- **Electron 32**
- **React 18**
- **TypeScript**
- **Vite / electron-vite**
- **Vitest**
- **SQLite / better-sqlite3**
- **Tree-sitter**
- **MCP**
- **WebSockets**
- **Repomix**
- **js-tiktoken**
- **Cytoscape**

The project also contains a Cloudflare-based gateway layer used by the remote context-access architecture.

## Repository map

```text
src/
├── main/
│   ├── core/                 repository, Code Map and context infrastructure
│   ├── mcp/                  agent-facing MCP and transport integration
│   ├── system-health/        diagnostic boundaries and fault localization
│   ├── runtime-identity/     source/runtime evidence identity
│   ├── validation-ledger/    reusable validation proofs
│   └── continuum/            durable project-scoped handoffs
├── preload/                  Electron process boundary
├── renderer/                 desktop interface
└── shared/                   cross-boundary contracts and types

infra/
└── gateway/                  remote MCP gateway infrastructure

scripts/                      validation, runtime, benchmark and MCP tooling
docs/                         architecture notes, spikes and operational documentation
assets/                       Code Awareness visual identity
```

The repository also contains older product surfaces and experiments that document the system's evolution. They should not all be interpreted as equally central to the current architecture.

## Current status

Code Awareness is an **active engineering project**, not a finished commercial product.

### Current / central

- Code Map
- CodeScope
- System Health
- Runtime Identity
- Validation Ledger
- Context Efficiency Harness

### Functional, evolving

- Continuum
- remote MCP/gateway infrastructure
- compression infrastructure

### Legacy or transitional

Some earlier UI surfaces and context-delivery approaches remain in the repository because the architecture evolved rapidly. Code Source and Code Compression began as primary product surfaces; Code Dash became a fallback/transition path; Journey/Campaign-era functionality represents earlier stages of the product.

### Direction

Academy is the planned procedural-context layer: a home for reusable engineering Skills and accumulated development knowledge. The latest Academy implementation was not part of the recoverable repository state used for this public baseline, so it is intentionally described here as direction rather than shipped capability.

## Running locally

### Requirements

This project targets Windows desktop development and includes native Electron dependencies.

The repository currently expects the npm version declared in `package.json` and contains runtime-policy tooling to detect incompatible environments.

### Bootstrap

```bash
npm run bootstrap
```

The bootstrap flow performs the native-runtime preflight, installs dependencies, rebuilds the required native module for Electron, and runs the native runtime doctor.

### Development

```bash
npm run dev
```

### Type checking

```bash
npm run typecheck
```

This gate checks the actual Node and Web projects without emitting files and requires an exact match with `scripts/typecheck-baseline.json`. New diagnostics or increased occurrences fail. Fixing known errors also fails the check until `npm run typecheck:baseline` explicitly reduces the baseline; that command refuses regressions. Neither command recreates a missing baseline.

`npm run typecheck:test` exercises the guard. Initial baseline creation is exceptional: `node scripts/typecheck-gate.cjs --bootstrap` creates it only when absent, after checking both projects, and never replaces an existing baseline. Do not use bootstrap to approve new debt; restore the versioned baseline instead.

### Validation

The repository exposes targeted validation lanes as well as a broad validation pipeline:

```bash
npm run test:run
npm run validate:codemap
npm run validate:context
npm run validate
```

Because native-module validation depends on the Electron/Windows runtime boundary, environment setup is part of the validation contract rather than an incidental prerequisite.

## What this project is exploring

Code Awareness is ultimately an experiment in a broader engineering question:

**What infrastructure does an AI engineering agent need in order to reason over a real software system with high context quality, low waste, persistent knowledge, and evidence it can trust?**

The project approaches that question through four recurring concerns:

1. **Context awareness** — make the right repository evidence accessible.
2. **Context economy** — avoid paying for irrelevant context.
3. **Reliability** — know whether tools, transports, source, and validation evidence are current and healthy.
4. **Continuity** — preserve valuable engineering context beyond one agent session.

The long-term direction is not to put more code into every prompt. It is to make the repository and its engineering knowledge **queryable enough that the agent can ask for exactly what it needs**.

## Author

Built by **Eric Rocha** as an ongoing exploration of context engineering, developer tooling, desktop architecture, and agentic software development.

## License

**Proprietary — All Rights Reserved.**

This repository is publicly available for inspection, but it is **not open source**. No permission is granted to modify, redistribute, create derivative works from, incorporate into another product, or otherwise reuse the original Code Awareness materials except where required by applicable law or the hosting platform's terms.

See [LICENSE](LICENSE) for the complete proprietary notice.
