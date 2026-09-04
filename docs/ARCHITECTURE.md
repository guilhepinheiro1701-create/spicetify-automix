# Architecture

## Shape of the thing

Smart DJ is a single Spicetify extension: one bundled IIFE, no custom app, no
separate page. It adds a button to the playbar and a panel inside Spotify's own
modal, so it reads as part of the client rather than beside it.

The code splits into layers that only talk downward. The engine has no idea
Spotify exists; the platform layer has no idea what a Camelot code is. That is
what makes the algorithm testable without a Spotify client — 312 unit tests run in
Node with no browser and no mocking of Spicetify, and `npm run smoke` boots the
real bundle against a stubbed client to cover the layers that are not pure.

```
src/
├── index.ts                    entry: boot, wire, expose window.SmartDJ
│
├── core/                       no dependencies on anything else
│   ├── types.ts                the domain model everything shares
│   ├── util.ts                 curves, clamps, dB, statistics
│   ├── logger.ts               namespaced logging + ring buffer
│   └── events.ts               typed emitter
│
├── config/
│   ├── defaults.ts             the Settings shape and its defaults
│   ├── settings.ts             validated, persisted, observable store
│   ├── intent.ts               DJ intent → scoring weights and blend floor
│   └── styles.ts               Smooth / DJ / Energetic / Chill / Seamless / Custom
│
├── platform/                   the only code that touches `Spicetify`
│   ├── spicetify.ts            defensive façade — probes, never assumes
│   ├── capabilities.ts         THE capability layer: flags, reasons, tier
│   └── nativeCrossfade.ts      four write paths to Spotify's own mixer
│
├── music/                      pure music theory, zero I/O
│   ├── camelot.ts              harmonic mixing
│   ├── tempo.ts                tempo compatibility, half/double-time, phrases
│   ├── energy.ts               energy matching and set-shape smoothness
│   └── loudness.ts             level matching and gain trim
│
├── analysis/
│   ├── providers/              manual → features → analysis → external → heuristic
│   │   └── internalEndpoint.ts shared failure policy for the spclient services
│   ├── features.ts             derives energy/brightness/pulse when Spotify's own are absent
│   ├── sections.ts             intro/build/drop/breakdown/outro + runway
│   ├── structure.ts            phrase grid, cue points, phase offset
│   ├── cache.ts                memory LRU + compact persistent tier
│   └── analyzer.ts             orchestration, merging, dedup, prefetch
│
├── engine/                     pure computation: analyses in, plan out
│   ├── bands.ts                PERFECT…VERY POOR, and what each permits
│   ├── scoring.ts              weighted model with hard-constraint caps
│   ├── confidence.ts           will it SOUND good, given the approach chosen
│   ├── strategy.ts             nine characters, and the mechanism for each
│   └── transitionEngine.ts     calculateTransition(A, B) → TransitionPlan
│
├── audio/                      the only code that changes playback
│   ├── automation.ts           volume ramps with guaranteed restore
│   ├── executors/              native-crossfade → volume-fade → passive
│   └── audioEngine.ts          the fallback ladder
│
├── queue/
│   ├── setlist.ts              chain scoring, cliff detection, optimizeSequence
│   └── trajectory.ts           the set's energy shape: building / peaking / releasing
│
├── runtime/
│   ├── scheduler.ts            two-stage, self-correcting firing
│   ├── memory.ts               versioned per-pair decision cache
│   ├── diagnostics.ts          local counters and the session log
│   └── smartDj.ts              the one stateful controller
│
└── ui/
    ├── panel.ts                the Smart DJ panel
    ├── explainer.ts            the why-this-transition checklist
    ├── debugOverlay.ts         live HUD
    ├── components.ts           DOM builders
    └── styles.ts               themed via --spice-* custom properties
```

## The flow of one transition

```
songchange
    │
    ├─► analyzer.analyze(current)   ─┐  cached, deduplicated,
    ├─► analyzer.analyze(next)      ─┤  prefetched for the next four
    │                                │
    ▼                                │
calculateTransition ◄────────────────┘
    │   DJ intent → scoring weights and blend floor
    │   classify both structures → mixable runway
    │   score the pair; hard failures cap rather than average
    │   band + energy direction + runway → strategy and mechanism
    │   size the blend from the runway, align to whole phrases
    │   pick the exit cue, snap it to a phrase line
    │   pull the trigger early by B's own grid phase
    │   pick the entry cue in track B
    │   re-score at the final geometry
    │   musical confidence, and a verdict per feature
    ▼
TransitionPlan
    │
    ▼
scheduler.arm(startPoint − leadIn)
    │   coarse poll ──► fine self-correcting chain ──► fire
    ▼
audioEngine.execute(plan)
    │
    ├─► native-crossfade   program the mixer, then next()      ← real overlap
    ├─► volume-fade        fade out, next(), seek, fade in     ← no overlap
    └─► passive            do nothing, deliberately
```

## Three decisions worth explaining

### Why the engine is pure

`calculateTransition` takes analyses, settings and a capability set, and returns
a plan. It reads no globals and touches no playback. Every interesting
behaviour — refusing a bad pair, shortening a blend, choosing a cue — is
therefore reachable from a unit test with plain data. The parts that *must*
touch the client (platform, audio, runtime) are deliberately thin.

### Why there is one capability layer

`Spicetify.Platform` is typed `any` and changes shape between Spotify versions.
Rather than scattering `typeof x === "function"` checks through the codebase,
one module probes the live client and publishes a flat set of booleans plus a
machine-readable reason for every absence. Every other module asks it.

That is what makes the project survivable: when Spotify removes something,
exactly one file notices, and each decision downstream degrades on its own. It
is also what makes the capability regression tests possible — they flip a flag
and assert nothing calls the missing API.

### Why technical fit and musical confidence are separate numbers

`compatibility.overall` says how much two tracks can be *overlapped*. It is not
a verdict on the pairing: a DJ moving from 90 BPM hip-hop into 145 BPM drum and
bass is making a contrast, not a mistake.

So `musicalConfidence` answers the second question — *given the approach we
chose, will it sound good?* A short, phrase-timed switch between incompatible
records scores high there; a long blend over a mediocre match scores low. Without
that split the engine is timid, apologising with a fade where it should be
cutting with intent.

### Why capabilities are probed, not assumed

`Spicetify.Platform` is typed `any` and its shape changes between Spotify
versions; the crossfade write paths are undocumented and version-dependent; the
audio-analysis endpoint is internal and may have no data for a given track.

So `platform/capabilities.ts` probes the live client at startup and produces a
`CapabilitySet` with an explicit ✅/⚠️/❌ per feature. Every downstream decision
reads from that set. The user sees the same set, verbatim, in the panel. Nothing
in the UI claims a capability the probe did not find.

### Why there is a fallback ladder rather than an on/off switch

The most likely failure is not a crash, it is a *partial* client: crossfade
writes rejected, or analysis missing for one track. A binary "works / doesn't"
design would give up in both cases. Instead each rung does the best available
thing:

| Rung | Requires | Gives you |
| --- | --- | --- |
| `native-crossfade` | a writable crossfade setting | real audio overlap, programmed per pair |
| `volume-fade` | `setVolume` | a musically-timed, level-matched switch with no overlap |
| `passive` | nothing | Spotify's own behaviour, untouched |

The same principle runs through the analysis chain (four providers, each filling
gaps the last left) and the scoring model (unknown data scores a neutral 0.5 and
lowers confidence — it never scores as *incompatible*).

## Performance

The brief asked for pre-analysis, cache, reuse. Concretely:

- A track is analysed **once, ever**. Results are cached in memory (60 tracks,
  full beat grids) and persisted in compact form (600 tracks, everything except
  the beat/bar/segment arrays — the derived phrase grid is stored instead, which
  is what the arrays were needed for).
- Concurrent requests for the same URI share one promise.
- The next four queue entries are prefetched during playback, so the plan is
  ready long before it is needed.
- Persistent writes are debounced to one every few seconds, and the whole cache
  survives a storage-quota rejection by halving itself.
- Nothing polls hard. The scheduler idles at 250 ms until the target is within
  1.5 s, then closes the gap with a self-correcting chain that lands inside
  ~30 ms without a busy loop. The debug HUD ticks at 2 Hz and only exists while
  debug mode is on.
- No audio is processed, because none can be. CPU cost is a few hundred
  arithmetic operations per track change.

## Safety

Playback must survive anything. The rules the code actually enforces:

- The audio engine never throws — every path returns an outcome.
- Volume ramps restore the captured baseline in a `finally`, and again on a
  watchdog if the API rejects the write.
- If the volume moves more than 0.04 from where we put it, a human did that: the
  ramp abandons itself and leaves their setting alone.
- A user skip, a pause, a queue change, or the extension being switched off
  aborts an in-flight transition and restores everything.
- If the queue changes between arming and firing, the plan is recomputed rather
  than executed against the wrong track.
- On teardown, the client's crossfade setting is put back the way it was found.
