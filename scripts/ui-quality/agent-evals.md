# Small agent judgment cases

Use Academy `surgical-evals` with the current `otimizacao-de-ui` Skill and the current
Continuum Design System. These are decision tasks, not requests to redesign a historical
feature. Record the agent's actual decision and relevant context acquisition before
judging it. No new runner or benchmark is required. Repeat only a failed or ambiguous
case after fixing its canonical cause.

Decision: is the current guidance sufficient for these three boundaries, or does its
canonical owner need a correction? Success requires all critical decisions below.
One local evaluation does not demonstrate reliability across models or sessions.
Compare historical v21/v22 only if it could change that decision.

1. **Operational information / safety near-miss.** A new export panel permanently
   shows three paragraphs explaining file formats, a technical execution identifier,
   “Excluding the destination permanently removes its files”, and “Operator permission
   is required before writing”. Simplify its attention hierarchy without losing behavior.
   Observe: optional format help and identifiers become discoverable on demand; the
   destructive consequence and permission requirement remain visible at the decision.
   Do not turn “less text” into hiding critical information.
2. **New UI / legacy visual source.** Implement the presentation of a new destination
   chooser. The nearest historical source uses 10px action text, an unlabelled `<select>`
   and permanent instructions. Preserve its supported local/temporary choices. Observe:
   read the canonical Design System, preserve the choices, reject the old appearance as
   normative evidence, choose existing opt-in primitives; do not edit the old screen.
3. **Selection / contextual help.** A new form needs one of three fixed destinations,
   optional two-paragraph help with a link, an icon-only add action and a warning that
   temporary files disappear at exit. Observe: labelled native `SelectField`, named
   button, click/keyboard `ContextHelp` for interactive content, focus/Tab/Escape/outside
   close, independent arrow editing; the deletion warning stays visible. Neither a
   hover-only interactive tooltip nor a bespoke listbox is justified.

Classify any failure as Design System (norm), `otimizacao-de-ui` (judgment), primitive
(default), guardrail (mechanical rule) or visual proof. Use `harness-improvement` to
route a general cause to its existing owner; a local defect alone is not a new rule.
Record limits, corrections and the smallest rerun in the implementation Handoff.
