# Phase 1–2 — Research and feasibility

Everything below was verified against current sources in 2026, not assumed from
older documentation. Where a capability turned out to be unavailable, the
finding is recorded here and the code degrades accordingly rather than
pretending.

## 1. The audio itself is unreachable

The single most important finding, and the one that shapes the whole project.

Spotify's desktop client is a Chromium Embedded Framework app — recent builds
pair Spotify 1.2.x with CEF 143 / Chromium 143 — but the audio path does not run
in the renderer where extensions live. The stream is fetched, decrypted, decoded
and mixed below the web layer. There is no `<audio>` or `<video>` element for an
extension to reach.

That closes off, completely:

- `AudioContext.createMediaElementSource()` — nothing to attach it to. Even
  where a protected media element exists, browsers do not let Web Audio tap
  EME-protected content: Firefox throws `NotSupportedError`, and
  `captureStream()` on an EME-protected element throws in Chromium too.
- Any real EQ, filter, or effect on the Spotify signal.
- Any per-deck gain during an overlap.
- Waveform or spectrum analysis of what is actually playing.

Corroborating evidence: no Spicetify extension in the ecosystem does DSP on the
stream. Visualiser extensions such as `Konsl/spicetify-visualizer` and
`mayurankv/Spicetify-Audio-Visualiser` all drive their graphics from *metadata*
(the audio-analysis payload), not from live audio. Standalone EQ tools for
Spotify (Equalify and similar) hook the operating system's audio stack, not the
client.

**Conclusion:** an extension cannot process Spotify's audio. Anything that
claims otherwise is either hooking the OS or not doing what it says.

## 2. But Spotify has its own mixer, and it is programmable

Spotify's own crossfade (Settings → Playback → Crossfade) *does* produce a real
audio overlap: during a track change both tracks sound at once, mixed below the
web layer.

Prior art — `janakchoudharydev/spicetify-glide` (MIT) — established the core
technique: enable the native crossfade, then call `Spicetify.Player.next()`
*early*, before the track ends. The result is genuine audio overlap rather than
a volume trick. Smart DJ builds on that idea and credits it.

More usefully, the crossfade *duration* is writable at runtime. Four undocumented
paths exist, and which ones work varies by client version, so all four are
attempted in order:

| Path | Call |
| --- | --- |
| ConfigAPI | `Spicetify.Platform.ConfigAPI.setAccountSetting("audio.crossfade_v2", …)` and `"audio.crossfade.time_v2"` (ms) |
| PlayerAPI prefs | `Spicetify.Platform.PlayerAPI._prefs.setCrossfade(enabled, seconds)` |
| Cosmos (main) | `CosmosAsync.post("sp://player/v2/main", { crossfade: { enabled, duration_ms } })` |
| Cosmos (connect) | `CosmosAsync.put("sp://connect/v1/player/crossfade", { enabled, duration })` |

This is what turns a fixed crossfade into a *computed* one: Smart DJ programs the
overlap length for the specific pair of tracks about to be joined, immediately
before triggering the switch.

**Caveat, and it matters for the stated goal.** Community reports through 2026
indicate recent desktop builds have moved crossfade behind Premium for Free
accounts. Since the brief explicitly targets Spotify Free, the project cannot
depend on this path. It probes at startup, reports the result honestly in the
UI, and falls back — see §7.

## 3. Track analysis: the public endpoint is closed, the internal one is not

On **27 November 2024** Spotify closed `/v1/audio-features` and
`/v1/audio-analysis` (along with recommendations, related-artists and featured
playlists) to any Web API application without pre-existing extended access. New
apps get 403. There is no official replacement.

That kills the obvious source of BPM, key and energy — but only for third-party
apps talking to `api.spotify.com`. The desktop client has its own door:

```js
Spicetify.getAudioData(uri)
// → GET https://spclient.wg.spotify.com/audio-attributes/v1/audio-analysis/{id}
//   via CosmosAsync, using the client's internal session
```

This is still present in `spicetify/cli` as of its August 2026 commits. It is
undocumented internal API on an internal host, it has no data for many tracks
(local files always; the long tail often), and it can vanish in any client
update. Smart DJ therefore treats it as a *provider that may fail*, counts
consecutive failures, and disables it for the session after a sustained run of
them rather than hammering a dead endpoint.

What it returns when it works is richer than the old audio-features endpoint:

- `track`: tempo, tempo confidence, time signature, key, mode, key confidence,
  loudness, `end_of_fade_in`, `start_of_fade_out`
- `beats`, `bars`, `tatums`: the full grid
- `sections`: structural boundaries with per-section loudness/tempo/key
- `segments`: per-segment loudness envelope and 12-coefficient timbre vectors

Note what is *not* there: `energy`, `danceability`, `valence`. Those were
audio-*features*, not audio-*analysis*. Smart DJ rebuilds energy, brightness and
pulse strength from the segment and beat data — see `src/analysis/features.ts`.
These are labelled "derived" and never presented as Spotify's own numbers.

## 4. Playback control: what exists

Verified against the Spicetify API reference and the CLI's own wrapper source.

| Capability | Status | Notes |
| --- | --- | --- |
| `Player.next()` / `back()` | ✅ | The switch trigger. |
| `Player.seek(ms)` | ✅ | Used for intro skipping on the fade path. |
| `Player.getProgress()` | ✅ | Interpolated from the state timestamp, so exact between events. |
| `onprogress` event | ✅ | Fires every 100 ms — too coarse alone, hence the two-stage scheduler. |
| `PlaybackAPI.setVolume()` | ✅ | Master fader only. One fader, not two. |
| `Queue.nextTracks` / `Player.data.nextItems` | ✅ | Next-track lookahead. |
| `UserAPI._product_state` (`_product_state_service` since 1.2.21) | ✅ | Free vs Premium detection. |
| **Playback rate for music** | ❌ | `PlayerAPI.setSpeed()` exists but applies to podcasts only. |

That last row is the reason true beatmatching is impossible — see §5.

## 5. Beatmatching: impossible, and what replaces it

Beatmatching needs tempo control. There is none for music. `setSpeed` is a
podcast feature; there is no key-lock, no pitch fader, no rate parameter.

So Smart DJ does **phase alignment** instead, which is the half of the job that
*is* achievable: it schedules the switch so that track B's first downbeat lands
on a downbeat of track A. When the tempos are already close — inside the ±6%
vinyl window or the ±8% same-genre limit that DJ practice treats as the outer
bound — that reads as a locked mix. When they are not, the engine says so and
shortens or abandons the overlap rather than laying two conflicting pulses over
each other.

The tempo scoring curve in `src/music/tempo.ts` encodes those DJ thresholds
directly: near-flat inside ±3%, still good to ±6%, degrading through ±8%, and
effectively zero past ±20%. Half- and double-time relationships are detected and
scored highly (70 → 140 BPM is a real technique), with a small penalty against a
direct match.

## 6. DJ technique the algorithm encodes

- **Harmonic mixing / Camelot wheel.** The 24 keys map to 1–12 plus A (minor) or
  B (major). Clean moves are: same code, ±1 with the same letter (a perfect
  fifth), and the same number with the other letter (relative major/minor). +2 is
  the deliberate "energy boost" exception. Everything else clashes.
  (Mixed In Key's rules, as implemented by Rekordbox, Serato, Traktor, Mixxx.)
- **Phrasing.** Dance and pop music is written in 4-beat bars grouped into 8, 16
  and 32-beat phrases. DJs switch on phrase boundaries because that is where the
  arrangement turns over. Smart DJ recovers the phrase grid by testing every bar
  offset and keeping the one whose phrase lines best agree with the section
  boundaries the analysis found.
- **Cue points.** The research on automatic cue-point detection (Zehren et al.,
  *Automatic Detection of Cue Points for DJ Mixing*) formalises what DJs do:
  switch points sit at structural events — a new section, a drop, an outro — and
  about 90% of automatically detected ones are usable. Smart DJ's exit-cue
  selection scores three candidate sources: the mastering fade-out, section
  boundaries in the back half (weighted up when energy drops across them), and
  the phrase grid.
- **The bass swap.** The standard move is to pull the outgoing track's low end
  out as the incoming one's comes in, so two basslines never occupy the same
  space. We cannot filter, so this is recorded as intent and approximated
  broadband on the fade path. It is flagged `approximated: true` everywhere.
- **Energy programming.** Sets build. A small upward step reads as momentum; a
  large jump in either direction reads as an error. The energy curve peaks at
  about +0.04 and falls off hard past ±0.45.
- **Loudness.** Spotify normalises to roughly −14 LUFS when normalisation is on.
  Differences under 1 dB are inaudible in a blend, ~3 dB is noticeable, ~10 dB is
  a jump-scare. Trims are capped at ±6 dB because a heavy trim sounds like a
  mistake rather than a mix.

## 7. Feasibility matrix

Legend: ✅ possible · ⚠️ partially possible · ❌ impossible

| Feature | Status | What Smart DJ actually does |
| --- | --- | --- |
| Real audio overlap between two tracks | ⚠️ | ✅ where the client accepts a crossfade write (usually Premium). Programmed per transition. ❌ where it does not — falls back to a shaped switch. |
| Deciding *when* the transition starts | ✅ | Cue selection from fade-out marker, sections and phrase grid. |
| Deciding *how long* it lasts | ✅ | Computed per pair, snapped to whole bars, clamped to the client's 12 s ceiling. |
| Phrase matching | ✅ | Grid recovered from bars + sections; switch snapped to a phrase line. |
| Beat/downbeat alignment (phase) | ✅ | Switch scheduled onto a downbeat, ±~30 ms. |
| Beatmatching (tempo warp) | ❌ | No rate control for music. The required adjustment is computed and *reported*, never applied. |
| Harmonic mixing | ✅ | Camelot scoring, where key data exists. |
| Energy matching | ⚠️ | ✅ as a derived proxy from segment/beat data. Spotify's own `energy` feature is no longer available. |
| Loudness normalisation | ⚠️ | Level matching on the fade path (attenuation only). ❌ during a native overlap — Spotify owns both streams. |
| EQ transitions (real per-band) | ❌ | No DSP hook exists. Intent is planned, approximated broadband on the fade path, and always flagged. |
| Filters / effects (LPF, HPF, sweeps) | ❌ | Same reason. Not faked. |
| Per-track gain during an overlap | ❌ | One master fader, not two. |
| Waveform / live spectrum analysis | ❌ | No access to the audio signal. |
| Volume automation | ⚠️ | Master volume only; backs off the moment the user touches it. |
| Reading the next track before it plays | ✅ | Queue lookahead + prefetched analysis. |
| BPM / key / structure per track | ⚠️ | ✅ where the internal service has data; falls back to overrides, an optional endpoint, then neutral defaults. |
| Preserving album segues | ✅ | Detected and left alone. |
| Skipping a dead intro | ⚠️ | ✅ on the fade path (needs a seek). ❌ mid-overlap. |
| Never breaking playback | ✅ | Every rung degrades; volume is always restored. |

## 8. Privacy

Everything runs locally by default. No account identifier, no listening history
and no audio leaves the machine.

- Analysis comes from the Spotify client's own internal service (a request the
  client already makes) or from local overrides.
- The cache is local storage only.
- The optional custom endpoint is **off by default** and requires the user to
  paste an HTTPS URL. It sends one GET per unknown track carrying only the
  Spotify track id, title and artist.
- That request deliberately uses the browser's `fetch` with
  `credentials: "omit"` and `referrerPolicy: "no-referrer"` — **never**
  `Spicetify.CosmosAsync`, which attaches the client's session token to every
  request it makes and would hand that token to a third-party host.

## 9. Build tooling

`spicetify-creator` is deprecated and no longer updated; the project's own
guidance is to use esbuild, Rollup, or a similar bundler directly. Smart DJ uses
esbuild to produce a single self-contained IIFE, which is exactly the shape
Spicetify loads.

## Sources

- [Spicetify — Extensions](https://spicetify.app/docs/development/extensions)
- [Spicetify — Player API](https://spicetify.app/docs/development/api-wrapper/methods/player)
- [Spicetify — Platform API](https://spicetify.app/docs/development/api-wrapper/methods/platform)
- [Spicetify — getAudioData](https://spicetify.app/docs/development/api-wrapper/functions/get-audio-data/)
- [Spicetify — CosmosAsync](https://spicetify.app/docs/development/api-wrapper/methods/cosmos-async)
- [Spicetify — Queue](https://spicetify.app/docs/development/api-wrapper/properties/queue)
- [spicetify/cli](https://github.com/spicetify/cli) — `src/jsHelper/spicetifyWrapper/`, `globals.d.ts`
- [spicetify/spicetify-creator](https://github.com/spicetify/spicetify-creator) — deprecation notice
- [janakchoudharydev/spicetify-glide](https://github.com/janakchoudharydev/spicetify-glide) — MIT, prior art for the native-crossfade technique
- [Spotify — Introducing some changes to our Web API (27 Nov 2024)](https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api)
- [Music Ally — Spotify removes features from Web API](https://musically.com/2024/11/28/spotify-removes-features-from-web-api-citing-security-issues/)
- [MDN — AudioContext.createMediaElementSource()](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/createMediaElementSource)
- [Bugzilla 1331763 — createMediaElementSource does not support EME content](https://bugzilla.mozilla.org/show_bug.cgi?id=1331763)
- [Mixed In Key — Harmonic Mixing Explained](https://mixedinkey.com/wiki/harmonic-mixing-explained-everything-you-need-to-know/)
- [Mixed In Key — Camelot Wheel](https://mixedinkey.com/camelot-wheel/)
- [Zehren, Alunno, Bientinesi — Automatic Detection of Cue Points for DJ Mixing (arXiv:2007.08411)](https://arxiv.org/pdf/2007.08411)
- [Automatic DJ Transitions with Differentiable Audio Effects (arXiv:2110.06525)](https://arxiv.org/pdf/2110.06525)
- [Wikipedia — Beatmatching](https://en.wikipedia.org/wiki/Beatmatching)
- [Spotify Community — crossfade availability for Free users on desktop](https://community.spotify.com/t5/Live-Ideas/Bring-back-Crossfade-feature-for-spotify-free-users/idi-p/7477712)
