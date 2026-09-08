# Repo Map Grammar RM2

Repo Discovery is a discovery representation, not a deep-context representation. It tells an AI what files exist, what they cost to inspect, and how files connect. Deep context belongs to specialized context mechanisms.

The only official layers are:

```text
RM2L1 = Inventory
RM2L2 = Connections
```

Every document is self-contained:

```text
RM2L<layer>
PROJECT{name=<JSON string>}
LEGEND{<layer grammar>}
MAP|H
<map records>
```

File records are tab-separated:

```text
[contextReference<TAB>]sourceTokens<TAB>path[<TAB>>target,...]
```

`sourceTokens` is the exact canonical `cl100k_base` count of the source file. Context References are persistent base36 file identities and are serialized only for files required as relationship targets. `>` contains unique outbound internal file relationships; inbound relationships are derived by reversing those edges.

Paths use deterministic hybrid encoding. Each directory branch is measured with the canonical tokenizer and emitted either flat or as a prefix-sharing directory ending in `/`; leading tabs identify nesting depth. Equal-cost branches use the flat form.

L1 contains project identity, exact paths, source token counts, and required Context References. L2 adds outbound file relationships. Structural elements, signatures, semantic payloads, and source snippets are not part of Repo Discovery.

Absent fields represent absent knowledge and must not be inferred as present.
