# Limitations

The honest list. Nothing here is softened, and each entry says what Smart DJ
does instead.

## How any of this was verified

Read [REAL-BEHAVIOUR.md](REAL-BEHAVIOUR.md) first. It sets out what was actually
exercised against a client simulator and what remains **untested on real
Spotify** — which is a real and important distinction that the rest of this
document assumes you have seen.

## Impossible — and will stay impossible

These are not missing features. They are consequences of where Spotify's audio
lives, and no amount of work on this extension changes them.

### Beatmatching (tempo warping)

**Why not:** the client exposes no playback-rate control for music.
`Platform.PlayerAPI.setSpeed` exists but applies to podcasts; it is a no-op for
tracks. There is no pitch fader, no key lock, no rate parameter.

**What happens instead:** the engine computes the adjustment a true beatmatch
would need and *reports* it. `bpmAdjustmentApplied` is hard-coded `false` and a
test asserts it on every capability combination. Where the tempos already agree
closely, the switch is **phase-aligned** — fired early by exactly the incoming
track's own grid phase so the two downbeats coincide. That is the achievable
half of the job, and it is real.

### EQ, filters, effects

**Why not:** Spotify's audio is fetched, decrypted, decoded and mixed below the
renderer. There is no `<audio>` element to attach a Web Audio graph to, and
EME-protected media cannot be routed through Web Audio in any case.

**What happens instead:** on the fade path only, the outgoing ramp is
front-loaded — an exponential curve rather than equal-power — which clears the
outgoing track out of the way sooner. That is the audible half of a bass swap,
applied broadband. It is labelled `front-loaded-fade`, never "EQ", and during a
native crossfade it is reported as `not-applicable` because Spotify owns both
streams and nothing can shape them.

There are no dB figures anywhere in the EQ plan. Numbers nothing applies were
removed in Phase 2 as theatre.

### Per-track gain during an overlap

**Why not:** Spotify exposes one master fader. During a native crossfade its own
mixer owns both streams.

**What happens instead:** loudness matching works on the fade path, where there
is only one track sounding at a time, and only ever *attenuates* — the incoming
track can arrive quieter than the outgoing one left, never louder than your own
volume setting. During an overlap it is reported as unavailable.

### Waveform or live spectrum analysis

**Why not:** same as EQ — no access to the audio signal.

### Reordering playlist tracks

**Why not:** Spotify's queue is two things stacked. Entries you queued by hand
carry `provider: "queue"` and can be removed and re-added. Everything else is
the *context* — the playlist or album playing through — and removing one does
not stop it coming round again in its own position.

**What happens instead:** the whole upcoming chain is analysed and weak links
are flagged either way. Reordering only ever moves user-queued entries, is off
by default, and says plainly when it cannot help.

## Conditional — depends on your client

### Real audio overlap

**Only where the client accepts a crossfade write.** Community reports through
2026 indicate recent desktop builds gate crossfade behind Premium, which is
exactly the audience this project was built for.

Four undocumented write paths are attempted (`ConfigAPI`, `PlayerAPI._prefs`,
and two Cosmos routes). If all four refuse, the tier drops to **fade** and the
panel says so.

**What the Phrase-Timed Fade still does**, and this is the part worth knowing:

- picks the same musical moment for the switch — a phrase boundary chosen from
  the structure
- **leads in** so the switch itself lands on that moment, rather than the fade
  merely starting there
- waits for the client to actually report the track change instead of sleeping a
  fixed interval, which is what closes the audible gap
- splits the fade according to the outgoing track's structure — longer out when
  it has a real outro, faster out when it stops dead
- can **skip a dead intro**, which the overlap path cannot do at all
- matches loudness

It is not a mix. It is a well-made switch, and the UI never calls it anything
else.

### Track analysis

`audio-analysis` and `audio-features` are **undocumented internal services** on
`spclient.wg.spotify.com`, reached through Cosmos with the client's own session.
They are a different door from the public Web API, whose equivalents were closed
to new applications in November 2024.

They can be withdrawn in any client update, and they have no data for many
tracks (local files always, the long tail often). Both are probed, both count
consecutive failures, and both disable themselves for the session after a
sustained run — a track with no data is remembered so it is not re-queried
every play, with a seven-day retry window because Spotify does backfill.

**Without them:** every pair scores neutrally with low confidence. Transitions
still happen, sized conservatively. Nothing breaks.

### Intro skipping

Fade path only. Seeking mid-overlap is not possible.

## Estimated — real numbers, but inferred

| Thing | How it is derived | Marked as |
| --- | --- | --- |
| Section labels (intro/build/drop/breakdown/outro) | energy contour and position within the track | each label carries a confidence; the panel shows "structure estimated" when absent |
| Derived energy / brightness / pulse | segment loudness and timbre, when `audio-features` is unavailable | the source is shown in the debug HUD (`spotify-features` vs `spotify-internal`) |
| Phrase grid phase | bar offset fitted against section boundaries | grid confidence scales the phrase score |
| Style affinity (6% of the score) | shared artists and timbre distance | the weakest component; it has never changed a band in any test case |

## Things that are honest but easy to over-read

**Downbeat alignment is as accurate as the client's switch latency allows.** The
phase offset is computed exactly from the beat grids. What we cannot measure
from inside the renderer is how long *your* client takes between the call and
the audio actually changing. That residual is exposed as **Advanced → switch
latency** for you to dial in by ear, and stated as a caveat on every plan that
claims alignment. It is not milliseconds-perfect and does not claim to be.

**The score is a technical measure, not a verdict on the pairing.**
`compatibility.overall` says how much two tracks can be *overlapped*. A POOR
score does not mean they should not follow one another — contrast is a normal DJ
move. That is why `musicalConfidence` exists as a separate number, and why the
`contrast` strategy cuts decisively rather than fading apologetically.

**Diagnostics are local.** Nothing is sent anywhere. There is no telemetry in
this project and there is not going to be.

## Compatibility risk

| If Spotify… | Then |
| --- | --- |
| removes `audio-features` | derived energy takes over; slightly worse energy matching |
| removes `audio-analysis` | no beat grid: no phrase or downbeat alignment, conservative lengths |
| removes all four crossfade write paths | drops to fade tier; still musical, no overlap |
| renames `Player.origin._queue` | reordering silently unavailable; analysis unaffected |
| renames `PlaybackAPI.setVolume` | drops to passive; Spotify behaves normally |
| changes the queue `provider` values | reordering conservatively refuses (unknown ≠ queue) |

Every one of these is detected at startup and shown in the panel. None can break
playback.
