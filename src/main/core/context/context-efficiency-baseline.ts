export const BASELINE_VERSION = 1 as const

export interface ScenarioBaseline {
  readonly tokens: number
  readonly characters: number
}

export interface ReadCodeEnvelopeBaseline {
  readonly serializedTokens: number
  readonly sourceTokens: number
  readonly envelopeTokens: number
}

export const BASELINE_V1 = {
  version: BASELINE_VERSION,
  scenarios: {
    discover_root:         { tokens: 5,  characters: 8   } satisfies ScenarioBaseline,
    discover_src:          { tokens: 13, characters: 42  } satisfies ScenarioBaseline,
    relationships_both:    { tokens: 15, characters: 49  } satisfies ScenarioBaseline,
    relationships_in:      { tokens: 9,  characters: 31  } satisfies ScenarioBaseline,
    relationships_out:     { tokens: 9,  characters: 34  } satisfies ScenarioBaseline,
    relationships_details: { tokens: 17, characters: 65  } satisfies ScenarioBaseline,
    inspect_service:       { tokens: 19, characters: 73  } satisfies ScenarioBaseline,
    inspect_signatures:    { tokens: 23, characters: 98  } satisfies ScenarioBaseline,
    navigation_overhead:   { tokens: 52, characters: 172 } satisfies ScenarioBaseline,
    read_code_envelope:    { serializedTokens: 37, sourceTokens: 28, envelopeTokens: 9 } satisfies ReadCodeEnvelopeBaseline
  }
} as const

export const BASELINE_V2 = {
  version: 2 as const,
  scenarios: {
    ...BASELINE_V1.scenarios,
    references_single:   { tokens: 17, characters: 57  } satisfies ScenarioBaseline,
    references_multiple: { tokens: 35, characters: 111 } satisfies ScenarioBaseline,
    references_empty:    { tokens: 7,  characters: 21  } satisfies ScenarioBaseline
  }
} as const

export const BASELINE_V3 = {
  version: 3 as const,
  scenarios: {
    ...BASELINE_V2.scenarios,
    dependencies_single:   { tokens: 16, characters: 59  } satisfies ScenarioBaseline,
    dependencies_multiple: { tokens: 42, characters: 141 } satisfies ScenarioBaseline,
    dependencies_empty:    { tokens: 7,  characters: 21  } satisfies ScenarioBaseline
  }
} as const

export const BASELINE_V4 = {
  version: 4 as const,
  scenarios: {
    ...BASELINE_V3.scenarios,
    hierarchy_up:    { tokens: 17, characters: 57 } satisfies ScenarioBaseline,
    hierarchy_down:  { tokens: 17, characters: 61 } satisfies ScenarioBaseline,
    hierarchy_both:  { tokens: 17, characters: 57 } satisfies ScenarioBaseline,
    hierarchy_empty: { tokens: 7,  characters: 21 } satisfies ScenarioBaseline
  }
} as const
