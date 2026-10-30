# Evals — scroll-film

`cases.yaml` holds the trigger boundary and two capability rubrics. None of it is deterministic CI:
routing and capability are judged by a model or a person.

**Triggering.** Load only this skill and its nearest siblings (`design`, `ai-media`,
`landing-copy`, `performance`) so routing is honest. Run each `should_trigger` prompt in 3 fresh
sessions; it passes when scroll-film fires in the majority. Each `should_not_trigger` passes when
scroll-film does not fire; check that the named `route_to` sibling really owns it. Bar: at least
90% of all trigger cases correct. `npm run routing:audit` adds a lexical check across the whole
catalog, which is a floor, not proof.

**Capability.** A/B on each scenario: the same prompt without the skill (baseline) and with it,
3 trials each, one grader for both arms. Grade every `must_include` line pass/fail. The skill
ships when the treatment clears 8.5/10 and beats the baseline by at least +1.0
(`scripts/skill-behavior-rubric.md`). Items both arms miss are suspect; rewrite them as behaviour
or remove them (`../../author-skill/references/eval-authoring.md`).

**The artifact checks are deterministic.** `scripts/verify.sh` (encode and seam checks) and the
engine's pure functions (`hold`, `planBands`, `shotOpacity`) are covered by
`tests/scroll-film.test.js` in `npm test`. The browser behaviour of the engine (Blob seeking on a
host without range support, seek coalescing under CPU throttle, phone sources, height-only resize,
reduced motion, no-JS copy) was checked by hand in headless Chrome with generated clips. It is not
in CI, which has no browser. Re-run it after any change to `assets/scrub-engine.js`.

Re-run both axes after any edit to the description or the body: both are wording-sensitive.
