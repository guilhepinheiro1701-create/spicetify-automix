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
- **how long to run** — sized to the pair's compatibility and the track's tempo,
  rounded to whole bars
- **which technique** — a long beat-aligned blend, a phrase blend, a short
  blend, a shaped switch, or deliberately nothing
- **where to come in** on the incoming track, skipping a dead intro when there
  is one
- **whether to refuse** — two tracks that do not fit get a clean switch, not a
  smeared crossfade

Scoring is weighted tempo 30% / key 22% / energy 18% / phrase 15% / loudness 9% /
style 6%, using DJ practice for every threshold: the Camelot wheel for harmonic
compatibility, ±6%/±8% tempo windows, 8/16/32-beat phrasing. The reasoning is
written up in [`docs/ALGORITHM.md`](docs/ALGORITHM.md).

## Be clear about the limits

Spotify's audio never reaches the web layer — it is decoded and mixed below the
renderer, with no media element and no DSP hook. So there are things this cannot
do, and it does not pretend otherwise. The panel shows the same list, probed from
your actual client.

| | Feature | Reality |
| --- | --- | --- |
| ✅ | Transition timing, length, cue points | Fully under our control |
| ✅ | Phrase matching | Grid recovered from bars + sections |
| ✅ | Downbeat (phase) alignment | Switch scheduled onto a downbeat |
| ✅ | Harmonic mixing | Camelot scoring, where key data exists |
| ✅ | Preserving album segues | Detected and left alone |
| ⚠️ | **Real audio overlap** | Only where the client lets us program its own crossfade — usually Premium. Otherwise a shaped switch with no overlap. |
| ⚠️ | Energy matching | Derived from segment/beat data; Spotify's `energy` feature is gone |
| ⚠️ | Loudness matching | Fade path only; impossible during a native overlap |
| ⚠️ | BPM / key / structure | Available for many tracks, not all |
| ❌ | **Beatmatching (tempo warp)** | No playback-rate control for music. The needed adjustment is *reported*, never applied. |
| ❌ | **Real EQ / filters** | No DSP hook exists. Intent is planned and approximated broadband, always flagged. |
| ❌ | Per-track gain during an overlap | One master fader, not two |
| ❌ | Waveform / live spectrum | No access to the audio signal |

The full investigation, with sources, is in
[`docs/RESEARCH.md`](docs/RESEARCH.md).

### A note for Spotify Free

The brief for this project was Spotify Free, and this is the honest position:
recent desktop builds appear to have moved the crossfade setting behind Premium.
Smart DJ probes for it at startup. If it can drive the mixer, you get real
overlap. If it cannot, it says so plainly in the panel and runs in **fade mode**:
the switch is still placed on a phrase boundary, still level-matched, still able
to skip a dead intro — there is simply no overlap, because none is available.

That is worth having, and it is not the same thing as a crossfade. Smart DJ will
not claim otherwise.

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

**Advanced:** minimum and maximum length, blend floor (the compatibility below
which the engine refuses to overlap), fade curve, auto mode, dead-intro skipping,
album-segue preservation, notifications, debug mode, cache management, and the
optional custom analysis endpoint.

### Styles

| Style | Character |
| --- | --- |
| **Smooth** | Discreet 3–8 s blends. Never draws attention to itself. |
| **DJ** | Phrase-aligned mixes on 16/32-beat boundaries. The default. |
| **Energetic** | Short, punchy switches that land on the downbeat and get out. |
| **Chill** | Long dissolves for ambient and downtempo. |
| **Seamless** | Maximum continuity: aggressive intro skipping, no silence. |
| **Custom** | Your own numbers, from Advanced settings. |

## Debug mode

Turn it on in Advanced settings for a live heads-up display:

```
SMART DJ · DEBUG
Current   Midnight City
Next      Instant Crush
BPM       128 → 126
Key       8A → 8A
Energy    0.81 → 0.79
Match     94% (conf 82%)
Plan      beat-aligned-blend / 32 beats
Phrase    matched
Downbeat  locked
Path      native-crossfade
Source    spotify-internal
ETA       42.3s
Status    ARMED
```

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

**The panel says "fade mode" / no audio overlap.**
The client rejected every crossfade write path. Check Settings → Playback →
Crossfade exists for your account; if it does not, this is the Premium gate and
fade mode is what is available. Smart DJ still times and shapes the switch.

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
npm test            # 199 unit tests
npm run smoke       # boot the built bundle against a stubbed client
npm run verify      # all of the above
```

The engine is pure: `calculateTransition(analyses, settings, capabilities)`
returns a plan and touches nothing. That is why the whole algorithm — scoring,
phrasing, cue selection, strategy, fallback — is tested in Node with no browser
and no Spicetify mock.

`npm run smoke` covers what the unit tests cannot: it loads the real bundle
against a stubbed Spotify client and checks three end-to-end scenarios — a
Premium-shaped client producing a phrase-aligned overlap, a Free-shaped client
falling back to a fade and restoring the user's volume exactly, and an album
segue being left alone.

Layout and design decisions: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

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
