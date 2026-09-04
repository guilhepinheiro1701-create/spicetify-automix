# Capabilities

Everything Smart DJ believes about the client comes from one place:
`src/platform/capabilities.ts`. No other module tests for an API directly.

That indirection exists because Spotify's internals change without notice. When
something disappears, exactly one file needs to notice, and every decision
downstream degrades on its own.

## The capability set

```ts
{
  audioAnalysis: boolean   // beat grid, bars, sections
  audioFeatures: boolean   // Spotify's real energy, valence, danceability
  crossfade:     boolean   // a writable native crossfade → real audio overlap
  volumeControl: boolean   // the master fader
  queueRead:     boolean   // lookahead at what is coming
  queueWrite:    boolean   // reordering user-queued entries
  preciseTiming: boolean   // millisecond playback position
  playbackRate:  boolean   // ALWAYS false — no rate control for music
  dsp:           boolean   // ALWAYS false — no hook into the audio
  perTrackGain:  boolean   // ALWAYS false — one fader, not two
}
```

Each capability also carries a status (`available` / `partial` / `unavailable`)
and, when it is not available, a **machine-readable reason**:

| Reason | Meaning |
| --- | --- |
| `dsp-unavailable` | Spotify's audio never reaches the web layer |
| `playback-rate-unavailable` | no rate control for music (`setSpeed` is podcasts-only) |
| `crossfade-not-writable` | the client refused every write path |
| `crossfade-premium-gated` | as above, on a Free account |
| `single-fader-only` | one master fader exists, not per-track gain |
| `api-missing` | the required call is not present on this client version |
| `endpoint-missing` / `endpoint-dead` | an internal service is absent, or stopped answering |
| `context-tracks-immutable` | playlist entries cannot be reordered without duplicating them |

Those identifiers are what the debug panel's *why not?* answers are built from,
and what the capability regression tests assert against. A future change cannot
quietly start claiming a capability without one of these disappearing from a
plan's verdicts, which fails a test.

## Tiers

The flags collapse into one of three tiers:

| Tier | Requires | Delivers |
| --- | --- | --- |
| **dj** | `crossfade` | real audio overlap, programmed per pair |
| **fade** | `volumeControl` | the **Phrase-Timed Fade**: a musically-timed, level-matched switch with no overlap |
| **passive** | nothing | Spotify's own behaviour, untouched |

## Auto-degradation

If Spotify changes tomorrow and `crossfade` becomes `false`, nothing breaks. The
audio engine walks down the ladder, and the reason is recorded:

```
native crossfade   ← real overlap
      ↓ capability unavailable / write refused
volume fade        ← phrase-timed switch, level-matched, intro-skip capable
      ↓ volume API rejected
passive            ← Spotify behaves exactly as it would without us
```

Degradations are counted in Diagnostics (`degraded`) and logged with the reason,
so a client update that quietly removes something shows up as a number rather
than as a mystery.

## Per-transition verdicts

Every plan records what became of each feature it considered:

```ts
{ feature: "beat-alignment",   used: true,  code: "used" }
{ feature: "tempo-adjustment", used: false, code: "capability-unavailable",
  detail: "the client exposes no playback-rate control for music" }
{ feature: "fade-shaping",     used: false, code: "disabled-by-user" }
```

`code` distinguishes three very different situations that all look like "off":

- **`capability-unavailable`** — the client cannot do it. Not our choice.
- **`disabled-by-user`** — you turned it off.
- **`data-missing`** / **`not-musically-appropriate`** — we could have, and
  decided not to.

The Transition Explainer renders these directly, so what the UI says and what
the engine did cannot drift apart.

## Reading it yourself

The panel's **Compatibility** section shows the live set with versions. From the
console:

```js
SmartDJ.dj.getCapabilities()      // the full set
SmartDJ.dj.getCapabilities().flags // the boolean view
SmartDJ.explain()                  // the current plan, including every verdict
```
