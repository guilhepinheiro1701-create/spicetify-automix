# Phase 2 audit — what actually works

An honest pass over the Phase 1 implementation, before improving it. Each row
says what the code claims, what it really does, and what was done about it.

## 1. Genuinely working, on real Spotify data

| Feature | Evidence |
| --- | --- |
| Beat grid, bars, sections | From the client's own `audio-analysis` service. Real per-track data. |
| **Real energy, valence, danceability** | **New in Phase 2.** The client also exposes `audio-attributes/v1/audio-features` — Spicetify's own bundled lyrics-plus app calls it. That is Spotify's real `energy`, not a proxy. |
| Tempo, key, mode, loudness | Both services agree; used directly. |
| Phrase grid recovery | Bar offset fitted against section boundaries. Verified on synthetic grids with a known offset. |
| Exit cue selection | Scored across the mastering fade-out, section boundaries and the grid. |
| Native crossfade programming | Four write paths, probed at runtime; one accepted in the smoke test. |
| Transition timing | Two-stage self-correcting scheduler, lands within ~30 ms of target. |
| Volume automation | Ramps with guaranteed restore and user-override backoff. |
| Album segue detection | Real, and correctly leaves playback alone. |

## 2. Estimated, and labelled as such

| Feature | What it really is |
| --- | --- |
| Derived energy / brightness / pulse | Rebuilt from segment loudness and timbre. Now **only a fallback**: where audio-features answers, Spotify's own numbers win. |
| Section labels (intro/build/drop/breakdown/outro) | Inferred from the energy contour and position. No ground truth exists; each label carries a confidence. |
| Style affinity (6% of the score) | Shared artists plus timbre distance. The weakest component — see §5. |
| Grid confidence | Residual of the section-alignment fit. A proxy for correctness, not a measurement. |

## 3. Simulated — and what changed

**The EQ plan was theatre.** Phase 1 computed `bassDuckDb`, `midHoldDb` and
`trebleBlendDb` to one decimal place. Nothing read them. The only consumer was
one line choosing an exponential fade curve when `eq.enabled` was true.

Three decimal numbers that no code path applies are not a feature, they are a
claim. **Removed.** `EqPlan` is now `{ enabled, shaping, approximated }` where
`shaping` is either `front-loaded-fade` (the real, audible bass-swap
approximation the fade path performs) or `not-applicable` (the overlap path,
which genuinely cannot act).

**`gain.trackA` was always 0** and remains so — there is one master fader, and
the field exists to make that explicit rather than to be set.

## 4. Dependent on undocumented internal APIs

Everything here is probed at runtime and degrades on failure.

| API | Risk | Mitigation |
| --- | --- | --- |
| `spclient…/audio-analysis/{id}` | Removed or emptied in a client update | Consecutive-failure counter disables it for the session; engine falls back to features, then overrides, then neutral defaults |
| `spclient…/audio-features/{id}` | Same | Same counter, shared helper |
| `ConfigAPI.setAccountSetting` | Renamed between versions | Three other write paths tried |
| `PlayerAPI._prefs.setCrossfade` | Private field | Guarded, one of four |
| `sp://player/v2/main`, `sp://connect/v1/…` | Resolver may vanish | Guarded, one of four |
| `UserAPI._product_state` | Renamed in 1.2.21 | All three known names probed |
| `Player.origin._queue` (via `Spicetify.addToQueue`) | Private | `canMutateQueue()` guard; reordering is opt-in and off by default |

**What breaks Smart DJ entirely:** nothing. The worst case is the passive tier,
where Spotify behaves exactly as it would without the extension.

**What degrades it:** losing both analysis endpoints drops every pair to a
neutral score with low confidence — transitions still happen, but sized
conservatively rather than musically.

## 5. Sophisticated in code, inaudible in practice

Asked honestly, three things did not earn their place:

1. **Style affinity (6%).** Timbre distance between two tracks moves the overall
   score by at most ~0.04. It has never changed a band or a strategy in any test
   case. **Kept but honestly weighted** — it is the tiebreaker it always was,
   not a feature.

2. **`brightness`.** Fed only into style affinity. Now also populated from
   `valence` when audio-features answers, which at least makes it a real number.

3. **The old duration formula.** `beats × intensity × compatibility × bias` was
   sophisticated-looking and mostly produced the same 8–10 s answer regardless
   of the pair, because the clamps dominated. **Replaced** by the structural
   runway — see below.

## 6. Defects found and fixed

Four of these were real bugs, not polish.

### The beat-alignment claim was false

Phase 1 set `beatAlignment: true` and printed *"first downbeat of B is scheduled
onto a downbeat of A"*. It only ever snapped **A's exit** to **A's** downbeat.
The incoming track begins at its own position zero, and its first downbeat lands
wherever its grid origin says — typically a fraction of a bar in. The two grids
had no reason to coincide.

Fixed: `gridPhaseOffsetSec()` computes B's grid phase, and the switch is fired
that much earlier so the grids actually meet. The residual is the client's own
switch latency, which cannot be measured from inside the renderer — so it is
exposed as **Advanced → switch latency** for the user to dial in by ear, and
stated as a caveat rather than hidden.

### On the Free path the switch landed off the phrase

The engine chose a phrase boundary, then the fade executor *started* its
fade-out there — so the actual `next()` happened 55% of the transition later,
squarely off the beat. Every Free-account transition was mistimed.

Fixed: plans now carry `leadInSec`, and the scheduler arms at
`startPointSec − leadInSec` so the **switch itself** lands on the chosen moment.

### Disabling Smart DJ mid-transition did not stop it

The settings handler called `disarm()`, which only cancels the scheduler. A
volume ramp already in flight kept running against a player the user had just
taken back. Fixed: the handler now aborts the audio engine too.

### Settings listeners leaked across restart

Three `settings.events.on(...)` subscriptions in `start()` were never stored, so
`stop()` could not remove them. Fixed: all are collected in `unsubscribers`, and
`stop()` clears the controller's cached state so a later `start()` inherits
nothing.

### Two scoring flaws found by the scenario corpus

- **A key clash got a *longer* blend than a perfect match.** The band's
  `windowUsage` only scaled the structural runway, so a mediocre pair with a big
  runway outlasted a perfect pair with a modest one. The band now caps length in
  absolute terms too.
- **60 → 180 BPM scored ACCEPTABLE (66%).** A weighted mean let a catastrophic
  tempo failure be averaged away by four dimensions that happened to agree. Hard
  constraints now *cap* the result instead of being averaged — and the cap
  respects caller-supplied weights, so a component weighted to zero cannot veto.

- **Blend lengths of 3 bars.** Grid alignment fell back to "nearest whole bar",
  producing 12-beat blends. DJs count in eights; alignment now prefers whole
  phrases, then power-of-two bar counts.

## 7. What is still impossible

Unchanged from Phase 1, and re-verified:

| | |
| --- | --- |
| ❌ Beatmatching (tempo warp) | No playback-rate control for music. `setSpeed` is podcasts-only. |
| ❌ Real EQ, filters, effects | Audio is decoded and mixed below the web layer. No media element, no DSP hook. |
| ❌ Per-track gain during an overlap | One master fader, not two. |
| ❌ Waveform / live spectrum | No access to the audio signal. |
| ❌ Reordering playlist context tracks | Removing one does not stop it coming round again. Only user-queued entries can move. |
| ⚠️ Real audio overlap | Only where the client accepts a crossfade write — usually Premium. |
| ⚠️ Intro skipping | Fade path only; a seek mid-overlap is not possible. |

## 8. Compatibility risk

| Change Spotify could make | Effect |
| --- | --- |
| Remove `audio-features` | Falls back to derived energy. Slightly worse energy matching. |
| Remove `audio-analysis` | No beat grid: no phrase or downbeat alignment, conservative lengths. Still functional. |
| Remove all four crossfade write paths | Drops to fade tier. Still musical, no overlap. |
| Rename `Player.origin._queue` | Reordering silently unavailable; analysis unaffected. |
| Rename `Platform.PlaybackAPI.setVolume` | Drops to passive tier. Spotify behaves normally. |
| Change the queue `provider` values | Reordering conservatively refuses (unknown ≠ queue). |

Every one of these is detected by `probeCapabilities()` at startup and shown in
the panel. None of them can break playback.
