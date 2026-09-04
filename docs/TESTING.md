# Testing

```bash
npm run verify      # typecheck → unit tests → build → smoke → playback
npm run situations  # the sixteen named situations, one at a time (a few minutes)
npm run timing      # where the switch lands against the beat grid, per tempo
```

312 unit tests, a four-scenario smoke suite and two real-time harnesses over the
built bundle. What each layer is for:

## Unit tests — the engine is pure

`calculateTransition(analyses, settings, capabilities)` reads no globals and
touches no playback, so the whole algorithm is testable in Node with no browser
and no Spicetify mock. That is deliberate, and it is why the interesting
behaviour is covered rather than just the plumbing.

| Suite | Covers |
| --- | --- |
| `camelot` | all 24 keys, wheel wrapping, relation ordering, unknown = neutral |
| `tempo` | the DJ thresholds, half/double-time folding, monotonicity, absurd input |
| `energyLoudness` | the ideal lift, cliffs, symmetry, trim capping |
| `structure` | phrase-grid recovery, snapping, cue selection, alignment |
| `features` | derived energy, payload normalisation, garbage tolerance |
| `scoring` | weights, ordering, hard-constraint caps, toggles |
| `transitionEngine` | plan invariants, technique selection, style presets |
| `scenarios` | realistic genre pairings — see below |
| `capabilities` | **mandatory regressions** — see below |
| `stability` | skip, pause, volume grab, API failure, teardown |
| `longrun` | 100 / 500 / 1000-track sessions |
| `lifecycle` | abort safety, listener hygiene, plan consistency |
| `analyzer` | provider chain, setlist, sequence optimisation, trajectory |
| `cache` / `settings` | persistence, corruption, quota rejection |

## Capability regressions — the mandatory ones

`tests/capabilities.test.ts` is the suite that stops a future change from
claiming something the client cannot do. Each test removes a capability and
asserts nothing downstream calls it, claims it, or reports it as used:

```
crossfade unavailable   → no crossfade calls, executor refuses, caveat present
DSP unavailable         → fade shaping never "used" on the overlap path
                          the EQ plan has no per-band values at all
rate unavailable        → bpmAdjustmentApplied false on every combination
per-track gain absent   → never claimed, loudness match reported unavailable
volume control absent   → degrades to passive, touches nothing
```

Two structural tests back these up:

- **every plan accounts for every feature** — a verdict is emitted for each of
  the seven features on every capability combination, so a feature cannot be
  silently dropped from the record
- **no verdict is marked used without a detail** — an empty explanation is a
  failure

## Scenario corpus — what the engine actually decides

`tests/scenarios.test.ts` runs realistic pairings and **prints its verdict for
each**, so the behaviour is inspectable rather than merely asserted:

```
house→house              EXCELLENT 94% · long        · 16 beats
edm→edm                  EXCELLENT 94% · long        · 16 beats
pop→pop                  GOOD      89% · smooth      ·  4.0s
pop→edm                  POOR      41% · safe        · fade-cut
ballad→edm               POOR      39% · safe        · fade-cut
long outro→long intro    EXCELLENT 95% · long        · 16 beats
short outro→short intro  GOOD      89% · fast        · quick-blend
energy rise              EXCELLENT 90% · energy-rise · 16 beats
60 → 180 BPM             POOR      50% · safe        · fade-cut
40 → 250, all wrong      POOR      15% · safe        · fade-cut
```

The assertions are about what a listener would notice — how long, whether it
overlaps, which character — not exact numbers, so they stay meaningful when the
weights are tuned.

**This corpus has caught real algorithmic flaws.** During Phase 2 it found a key
clash receiving a *longer* blend than a perfect match, and blends landing on
three bars when DJs count in eights. Both were fixed.

## Long-run simulation

Every structure that accumulates over a session is driven past its limit and
asserted bounded: the analysis cache (both tiers), transition memory, the
session log, the logger's ring buffer, and the stored payload size.

It also proves no work is repeated — each track analysed exactly once across two
full passes of a 200-track playlist, concurrent requests sharing one promise,
and prefetch not re-queueing cached tracks.

This is where the negative-result caching came from: the simulation showed
tracks with no analysis being re-queried against the internal endpoints on every
play.

## Stability

Six things a listener does that must never leave the player worse off:

| Scenario | Assertion |
| --- | --- |
| skip mid-transition | cancels immediately, volume restored exactly |
| pause mid-transition | no further volume changes after the abort |
| user grabs the volume slider | backs off, leaves their value alone |
| Spotify changes track itself | no double execution |
| client APIs fail | degrades to passive, no crossfade or seek calls |
| API fails then recovers | the original level is remembered and restored |

These found two real bugs: an exception inside a poll callback that left an
orphaned interval and an unresolvable promise, and `restore()` discarding the
baseline before the write had succeeded — so a client that recovered had nothing
to restore to.

## Smoke — the real bundle

`npm run smoke` loads `dist/smart-dj.js` against a stubbed Spotify client:

1. **Premium-shaped client** — real overlap, phrase-aligned, Spotify's own
   energy values, verdicts recorded, decision remembered
2. **Free-shaped client** — falls to fade, leads in so the switch lands on the
   phrase, volume restored to the exact starting value
3. **Album segue** — left completely alone
4. **Queue safety** — nothing touched while reordering is off, weak link still
   flagged

This covers what unit tests cannot: capability probing, the provider chain,
scheduling, and the executors, without needing a Spotify install.

## Playback — a client that behaves like the real one

`npm run playback` is the harness that should have existed from the start.
`scripts/simulator.mjs` models the one behaviour the smoke suite never did:
**Spotify emits `songchange` for our own `next()`, exactly as it does for the
user pressing skip**. Everything else follows from that — switch latency,
`onprogress` every 100 ms, position advancing in real time, crossfade writes
accepted or refused.

It runs at wall-clock speed on purpose. The volume ramps and the scheduler use
real timers, so compressing simulated playback makes a track end mid-fade and
measures an artifact rather than the product — which is exactly what the first
version of this harness did, and why it reported success on a broken build.

## Situations — the sixteen named cases

`npm run situations` answers the sixteen situations from the Phase 4 brief one
at a time, each with what was expected, what actually happened, a verdict and a
reason. Two levels are used, and each case says which:

- **live** — a real-time session against the simulator, for anything about what
  happens to playback (does the switch fire, does the level come back, does an
  interruption break something).
- **engine** — the shipped engine called directly, for anything about the
  *decision* (does a key clash get a shorter blend than a perfect match), which
  a volume trace cannot show.

## What the tests do not prove

They prove the code is consistent and the decisions are defensible. They cannot
prove it *sounds* good — no audio is accessible to test against.

That is what the experimental mode is for: turn on Debug mode, listen for an
hour, and read the session log back. It records what was decided and why for
every transition, which is enough to judge the algorithm without ever touching
the audio.
