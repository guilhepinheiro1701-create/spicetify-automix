# Smart DJ for Spicetify

Musically-aware automatic transitions for the Spotify desktop client.

Not a crossfade slider. For every pair of tracks, Smart DJ works out whether they
fit, where the outgoing track's phrase ends, how long a blend that pair can
carry, and whether to blend at all — then executes it with the best technique the
client actually supports.

```
┌──────────────────────────────────────────┐
│  SMART DJ                                │
│                                          │
│  ● Enabled            Style  [ DJ ▼ ]    │
│  Intensity  ────────────○───────  60%    │
│                                          │
│  ☑ Beat alignment   ☑ Harmonic mixing    │
│  ☑ Phrase matching  ☑ Energy matching    │
│  ☑ Smart EQ         ☑ Loudness norm.     │
│                                          │
│  Midnight City  →  Instant Crush         │
│  128 BPM · 8A · E 0.81   126 · 8A · 0.79 │
│                                          │
│  Compatibility            94%            │
│  ███████████████████████████░░           │
│                                          │
│  Technique   beat-aligned blend          │
│  Length      15.0s · 32 beats            │
│  Alignment   phrase + downbeat           │
│  Status      armed · in 42.3s            │
└──────────────────────────────────────────┘
```

## What it actually does

For each transition it decides, from the music:

- **when to start** — from the mastering fade-out, a section boundary, or the
  phrase grid, snapped to a downbeat
- **how long to run** — sized to the *structural runway*: how much outro the
  outgoing track has and how much intro the incoming one has. Two tracks at the
  same BPM get very different transitions depending on whether one fades out
  over thirty seconds or stops dead
- **which technique** — a long beat-aligned blend, a phrase blend, a short
  blend, a shaped switch, or deliberately nothing
- **where to come in** on the incoming track, skipping a dead intro when there
  is one
- **whether to refuse** — two tracks that do not fit get a clean switch, not a
  smeared crossfade
- **which of nine strategies fits** — SMOOTH, DJ, FAST, LONG, ENERGY RISE,
  ENERGY DROP, HARMONIC, CONTRAST or SAFE, chosen from the score band, the
  energy direction and the runway

Scoring is weighted tempo 30% / key 22% / energy 18% / phrase 15% / loudness 9% /
style 6%, using DJ practice for every threshold: the Camelot wheel for harmonic
compatibility, ±6%/±8% tempo windows, 8/16/32-beat phrasing. A catastrophic
failure in a hard constraint *caps* the result rather than being averaged away —
two tracks 50% apart in tempo do not become mixable because they share a key.

The score lands in a band that really drives behaviour:

| Band | Score | What changes |
| --- | --- | --- |
| **PERFECT** | 96–100 | use the whole runway |
| **EXCELLENT** | 90–95 | a long mix is safe |
| **GOOD** | 80–89 | one phrase, no longer |
| **ACCEPTABLE** | 65–79 | short overlap only |
| **POOR** | 45–64 | no overlap — a deliberate, phrase-timed switch |
| **VERY POOR** | <45 | fade out, fade in |

A low band is **not** a verdict on the pairing. It says how much the two tracks
can be *overlapped*. Contrast is a normal DJ move, so a second number —
**musical confidence** — answers the different question of whether the approach
actually chosen will sound good. A short switch between two incompatible records
scores high there; a long blend over a mediocre match scores low.

The reasoning is written up in [`docs/ALGORITHM.md`](docs/ALGORITHM.md), and an
honest audit of what works, what is estimated and what was removed as theatre is
in [`docs/AUDIT.md`](docs/AUDIT.md).

## Be clear about the limits

Spotify's audio never reaches the web layer — it is decoded and mixed below the
renderer, with no media element and no DSP hook. So there are things this cannot
do, and it does not pretend otherwise. The panel shows the same list, probed from
your actual client.

| | Feature | Reality |
| --- | --- | --- |
| ✅ | Transition timing, length, cue points | Fully under our control |
| ✅ | Phrase matching | Grid recovered from bars + sections |
| ✅ | Downbeat (phase) alignment | The switch is fired early by the incoming track's own grid phase, so the two grids actually coincide. Residual error is the client's switch latency — tunable in Advanced. |
| ✅ | Structure-aware sizing | Intro/build/drop/breakdown/outro inferred; the runway sets the length |
| ✅ | Set-level analysis | The whole A→B→C→D→E chain is scored and weak links flagged |
| ✅ | Harmonic mixing | Camelot scoring, where key data exists |
| ✅ | Preserving album segues | Detected and left alone |
| ⚠️ | **Real audio overlap** | Only where the client lets us program its own crossfade — usually Premium. Otherwise a shaped switch with no overlap. |
| ✅ | Energy matching | Spotify's **real** `energy`/`valence` from the client's internal audio-features service, with a derived proxy as fallback |
| ⚠️ | Queue reordering | Only entries you queued yourself. Playlist order cannot be changed without duplicating tracks. Opt-in, off by default. |
| ⚠️ | Loudness matching | Fade path only; impossible during a native overlap |
| ⚠️ | BPM / key / structure | Available for many tracks, not all |
| ❌ | **Beatmatching (tempo warp)** | No playback-rate control for music. The needed adjustment is *reported*, never applied. |
| ❌ | **Real EQ / filters** | No DSP hook exists. Intent is planned and approximated broadband, always flagged. |
| ❌ | Per-track gain during an overlap | One master fader, not two |
| ❌ | Waveform / live spectrum | No access to the audio signal |
| ❌ | Reordering playlist tracks | Removing a context track does not stop it coming round again |

The full investigation, with sources, is in
[`docs/RESEARCH.md`](docs/RESEARCH.md).

### "Phrase-Timed Fade" is a cut, not a mix

Where no overlap is available, Smart DJ does **not** perform a long crossfade
with the volume — that would cost several seconds of music to hide a switch gap
of about a tenth of a second, and it is what makes a naive implementation sound
like automation rather than a transition.

What it does instead is a **phrase-timed cut**: the level dips about one bar, to
roughly a third of your setting rather than to silence, the switch lands on the
phrase boundary, and the level comes back over about a bar. The dip exists to
mask the client's gap. The transition is the *timing*, not the fade.

The UI calls it a **Phrase-Timed Fade**. It is not a DJ mix, and nothing in the
product calls it one.

### A note for Spotify Free

The brief for this project was Spotify Free, and this is the honest position:
recent desktop builds appear to have moved the crossfade setting behind Premium.
Smart DJ probes for it at startup. If it can drive the mixer, you get real
overlap. If it cannot, it says so plainly in the panel and runs as a **Phrase-Timed Fade**:
the switch is still placed on a phrase boundary, still level-matched, still able
to skip a dead intro — there is simply no overlap, because none is available.

That is worth having, and it is not the same thing as a crossfade. Smart DJ will
not claim otherwise.

Phase 2 put real work into this path specifically, because it is the one most
people will be on:

- **The switch now lands on the beat.** Previously the fade *started* on the
  phrase boundary, which put the actual track change over half a transition
  late. Plans now carry a lead-in so the switch itself is on the music.
- **The gap is measured, not guessed.** The executor waits for the client to
  actually report the new track instead of sleeping a fixed 220 ms.
- **The fade split follows the structure.** A track with a real outro spends
  longer leaving; one that stops dead gets out fast and gives the time to the
  incoming track.
- **Intro skipping works here and only here** — a seek mid-overlap is impossible,
  so the Free path can do something the Premium one cannot.

One thing to know either way: where the overlap path *is* available, Smart DJ
drives Spotify's own crossfade setting — it writes the length it computed for
each pair immediately before triggering the switch. Your original crossfade
setting is read at startup and restored when the extension is torn down.

## Install

Requires [Spicetify](https://spicetify.app) and the Spotify desktop client.

```bash
git clone https://github.com/guilhepinheiro1701-create/spicetify-automix.git
cd spicetify-automix
npm install
npm run build
npm run install:spicetify
```

`install:spicetify` copies the bundle into your Spicetify Extensions folder and
runs `spicetify config extensions smart-dj.js && spicetify apply`.

<details>
<summary>Manual install</summary>

```bash
npm run build
```

Copy `dist/smart-dj.js` into your Extensions folder:

- **Windows** `%appdata%\spicetify\Extensions\`
- **macOS / Linux** `~/.config/spicetify/Extensions/`

Then:

```bash
spicetify config extensions smart-dj.js
spicetify apply
```
</details>

Open the panel from the **Smart DJ** button in the playbar.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Enabled | on | Master switch |
| Style | DJ | Smooth · DJ · Energetic · Chill · Seamless · Custom |
| Intensity | 60% | How far the engine may push toward long, obvious mixes |
| Beat alignment | on | Land the switch on a downbeat |
| Harmonic mixing | on | Score key compatibility on the Camelot wheel |
| Phrase matching | on | Only switch on 8/16/32-beat boundaries |
| Smart EQ | on | Bass-swap *intent*; approximated broadband on the fade path |
| Energy matching | on | Prefer a gentle lift over a jarring jump |
| Loudness normalization | on | Attenuate an incoming track that is much louder |
| Reorder the queue | **off** | Pull a better-matching track forward when the next transition would be poor. Only moves tracks you queued yourself. |
| DJ intent | Balanced | Smooth / Balanced / Energetic / Experimental — changes what the engine optimises for, not just its clamps |
| Switch latency | 0 ms | How long your client takes to change track. Dial in by ear if downbeat alignment sounds early or late. |

**Advanced:** minimum and maximum length, blend floor (the compatibility below
which the engine refuses to overlap), fade curve, auto mode, dead-intro skipping,
album-segue preservation, notifications, debug mode, cache management, and the
optional custom analysis endpoint.

### DJ intent

| Intent | What changes |
| --- | --- |
| **Smooth** | Leans hard on tempo and key. Would rather skip a mix than make a rough one. |
| **Balanced** | The researched default. |
| **Energetic** | Programmes for the energy arc and continuity. Shorter, more decisive. |
| **Experimental** | Relaxes the technical constraints and leans on structure, so deliberate contrast cuts become available. |

Intent moves the scoring weights; style shapes how a transition sounds once
chosen. They are separate on purpose.

### Styles

| Style | Character |
| --- | --- |
| **Smooth** | Discreet 3–8 s blends. Never draws attention to itself. |
| **DJ** | Phrase-aligned mixes on 16/32-beat boundaries. The default. |
| **Energetic** | Short, punchy switches that land on the downbeat and get out. |
| **Chill** | Long dissolves for ambient and downtempo. |
| **Seamless** | Maximum continuity: aggressive intro skipping, no silence. |
| **Custom** | Your own numbers, from Advanced settings. |

## Measuring whether it is actually better

Tests prove the code is consistent. They cannot prove it sounds good — no audio
is reachable. So Smart DJ records its own decisions instead.

Turn on **Debug mode** and the panel grows a **Diagnostics** section: how many
transitions were attempted, how many degraded to a lower tier, the average score
and confidence, and a full session log of every decision. "Copy session log"
gives you the lot as text. Listen for an hour, read it back, and judge the
algorithm on what it chose and why.

Everything stays on your machine. There is no telemetry in this project.

```
SMART DJ — SESSION LOG
Planned 34 · attempted 31 · completed 29 · aborted 2 · degraded 0
Average score 78% · average confidence 81% · poor 4

21:14:02  Midnight City → Instant Crush
  94% EXCELLENT · confidence 88% (high)
  strategy long · beat-aligned-blend · 16 beats
  exit outro → entry intro · runway 18s (outro)
  phrase matched · downbeat locked
  components: tempo 97 key 100 energy 91 phrase 86 loudness 98
  execution: native-crossfade · completed — 7.5s native crossfade
```

## Debug mode

Turn it on in Advanced settings for a live heads-up display:

```
SMART DJ · DEBUG
Current   Midnight City
Next      Instant Crush
BPM       128 → 126
Key       8A → 8A
Energy    0.81 → 0.79
Match     94% EXCELLENT (conf 82%)
Strategy  LONG
Plan      beat-aligned-blend / 16 beats
Runway    18.0s (outro)
Structure IBBBO · intro 24s · outro 18s
Phrase    matched
Downbeat  locked −180ms
Chain     94 · 71 · 88
Path      native-crossfade
Source    spotify-features
ETA       42.3s
Status    ARMED
```

`Chain` is the upcoming A→B→C→D→E transitions, so a bad one three tracks away is
visible before it arrives.

From the console:

```js
SmartDJ.explain()   // full plan, score breakdown, reasoning, and limits
SmartDJ.replan()    // recompute for the current pair
SmartDJ.open()      // open the panel
SmartDJ.teardown()  // remove cleanly
```

## Privacy

Everything runs locally. No account identifier, no listening history and no audio
leaves your machine.

- Analysis comes from the Spotify client's **own internal service** — a request
  the client already makes — or from your local overrides.
- The cache is local storage only.
- The **custom analysis endpoint is off by default**. If you enable it with an
  HTTPS URL, it sends one GET per unknown track carrying only the Spotify track
  id, title and artist. That request uses the browser's `fetch` with
  `credentials: "omit"` — deliberately *not* `Spicetify.CosmosAsync`, which
  attaches your Spotify session token to every request it makes.

## Troubleshooting

**The panel says "Phrase-Timed Fade" / no overlap.**
The client rejected every crossfade write path. Check Settings → Playback →
Crossfade exists for your account; if it does not, this is the Premium gate and
the phrase-timed fade is what is available. Smart DJ still times and shapes the
switch.

**BPM and key show as `?`.**
The internal analysis service has no data for that track — common for local
files and the long tail. The engine still plans a transition, scored neutrally
with low confidence. You can set values yourself:

```js
SmartDJ.analyzer.setOverride(Spicetify.Player.data.item.uri, { tempo: 128, key: 9, mode: 0 })
```

(`key` is a pitch class, C=0 … B=11; `mode` is 1 for major, 0 for minor.)

**Transitions never fire.**
Check `SmartDJ.dj.getStatus()`. Common and intended reasons: repeat-one is on,
the track is under 25 s, the next two tracks are from the same album, or the
current position is already past the planned exit.

**Volume ended up somewhere odd.**
It should not — every ramp restores its baseline. `SmartDJ.dj.audio.abort()`
forces a restore. Please open an issue if you can reproduce it.

**Nothing loaded at all.**
Confirm `spicetify config extensions` lists `smart-dj.js`, re-run
`spicetify apply`, and check the console for `[SmartDJ:boot]`.

## Development

```bash
npm run build       # bundle to dist/smart-dj.js
npm run watch       # rebuild on change
npm run typecheck   # tsc --noEmit
npm test            # 312 unit tests
npm run smoke       # boot the built bundle against a stubbed client
npm run playback    # a real-time session against a Spotify simulator
npm run timing      # where the switch lands against the beat grid
npm run verify      # all of the above
npm run situations  # the sixteen named situations, with a verdict each
```

The engine is pure: `calculateTransition(analyses, settings, capabilities)`
returns a plan and touches nothing. That is why the whole algorithm — scoring,
phrasing, cue selection, strategy, fallback — is tested in Node with no browser
and no Spicetify mock.

`npm run playback` is the one that matters most. It runs the built bundle
through a real-time session against a simulator that emits `songchange` in
response to our own `next()` — the behaviour that neither the unit nor the smoke
suite modelled, and which was hiding a bug that cancelled every transition
halfway through. It asserts the volume comes back to exactly where the user had
it, in every interruption case.

`npm run situations` answers the sixteen situations the product was challenged
with — genre pairs, tempo extremes, key clashes, and every way a listener can
interrupt a transition — printing what was expected, what happened, and a
verdict for each. It takes a few minutes, because the sessions run at
wall-clock speed on purpose.

`npm run smoke` covers what the unit tests cannot: it loads the real bundle
against a stubbed Spotify client and checks four end-to-end scenarios — a
Premium-shaped client producing a phrase-aligned overlap with Spotify's real
energy values, a Free-shaped client falling back to a fade and restoring the
user's volume exactly, an album segue being left alone, and the queue being left
untouched while reordering is off.

`tests/scenarios.test.ts` is the corpus of realistic pairings — house→house,
EDM→EDM, pop→EDM, ballad→EDM, long-outro→long-intro and the extremes — and it
prints the engine's verdict for each, so you can see what it thinks and why.

### Documentation

| | |
| --- | --- |
| [REAL-BEHAVIOUR.md](docs/REAL-BEHAVIOUR.md) | what actually happens in the player, and how it was verified |
| [INSTALLATION.md](docs/INSTALLATION.md) | step-by-step, for non-developers |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | when something is not working |
| [LIMITATIONS.md](docs/LIMITATIONS.md) | what it cannot do, and why — read this one |
| [CAPABILITIES.md](docs/CAPABILITIES.md) | the capability layer and auto-degradation |
| [COMPATIBILITY.md](docs/COMPATIBILITY.md) | which APIs it depends on, and what happens when they change |
| [ALGORITHM.md](docs/ALGORITHM.md) | every threshold, and where it comes from |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | layout and design decisions |
| [TESTING.md](docs/TESTING.md) | what is covered, and what tests cannot prove |
| [AUDIT.md](docs/AUDIT.md) | honest audit: what works, what is estimated, what was removed |
| [RESEARCH.md](docs/RESEARCH.md) | the original feasibility investigation, with sources |

## Credits

- [Spicetify](https://spicetify.app) for the extension platform.
- [spicetify-glide](https://github.com/janakchoudharydev/spicetify-glide) (MIT)
  established the technique of driving Spotify's native crossfade with an early
  `Player.next()` to get real audio overlap. Smart DJ builds on that idea and
  adds per-pair analysis, phrase and downbeat alignment, computed durations, and
  the fallback ladder.
- Harmonic mixing follows [Mixed In Key](https://mixedinkey.com/camelot-wheel/)'s
  Camelot conventions.
- Cue-point heuristics draw on Zehren et al.,
  [*Automatic Detection of Cue Points for DJ Mixing*](https://arxiv.org/pdf/2007.08411).

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with or endorsed by Spotify. Uses undocumented internal client
APIs that may change or disappear in any Spotify update; the extension detects
that at runtime and degrades rather than breaking playback.
