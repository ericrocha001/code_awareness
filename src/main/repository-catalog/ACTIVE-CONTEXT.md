# Active Context

`ActiveProjectService` owns the instance's selected focus and its in-memory context projection. Repository Catalog supplies logical identity; Code Map supplies its own legacy index ID and readiness. Runtime Identity and Git remain independent authorities. No data or identity is inferred from the Electron source checkout.

`RepositoryRuntimeService.activate(repositoryId)` resolves an available Catalog record, binds that identity, then requests Code Map preparation with the existing `openRepository` policy. The response does not wait for Code Map or its maintenance. Failure updates capability readiness without removing the selected repository or deactivating independent services.

`project.id` is the Catalog ID for Catalog-bound selections. `context.legacyCodeMapProjectId` is an explicit adapter for consumers requiring the index ID; it never replaces `context.repositoryId`. Legacy `project:activate` still accepts IDs of open Code Map projects. When a Catalog record exists for that path, it binds the canonical record. Otherwise the legacy selection remains usable, with logical identity `UNBOUND` rather than an invented repository ID.

## Revisions and events

- `ActiveProjectState.revision` changes only when selected identity or checkout changes. Domain guards continue using this revision.
- `context.revision` changes when the derived context changes. `project:get-active` and the existing `project:active-changed` event expose the additive projection.
- The existing `onChanged` stream carries selection and readiness snapshots. Selection consumers compare the selection revision before teardown/rebinding. The Main composition root does this before activating Continuum, Git, Validation and MCP.
- `onBeforeChange` runs only for selection transitions. Readiness changes do not quiesce the Channel or re-open a corpus.
- Selection intentions and Code Map completions are guarded independently. A superseded intention cannot publish an old project after asynchronous teardown; a late preparation result cannot change the newer context, a closed selection or a disposed instance.
- Snapshots are copied for callers and observers. No context Store, index, event bus or Worktree watcher is introduced.

## Capability readiness

`UNINITIALIZED` means not requested, `INITIALIZING` means preparation is in progress, `READY` means the capability's own readiness contract is satisfied, `DEGRADED` means a known partial failure, and `UNAVAILABLE` means the requested capability could not be provided. These states do not qualify feature acceptance.

Code Map preparation and maintenance publish bounded completion updates. Reads also derive current readiness from the existing model, including subsequent failures or recovery; they do not open or index a repository. Continuum readiness follows its actual activation result. Channel readiness follows the existing Channel state projection, including disabled, offline and setup states; a running MCP server alone is insufficient.

The default projection is HOST with the existing canonical data policy. Main supplies PREVIEW mode and the session ID only after the existing cooperative bootstrap has accepted its configuration; its existing private, initially empty profile is reported as EMPTY. This does not certify a contextual bootstrap or a data snapshot. Automatic PREVIEW selection, full manifest validation, data provisioning and selection restrictions belong to Unit B.
