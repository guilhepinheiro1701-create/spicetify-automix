# What actually happens in the player

This document exists because the previous three phases proved the code was
consistent, and the extension still barely worked. Passing tests were not
evidence. This is the evidence.

## How things were verified — and the limit of it

Everything below was exercised against a **Spotify client simulator**
(`scripts/simulator.mjs`) that reproduces the client's observable behaviour:
it emits `songchange` in response to `next()`, applies a realistic switch
latency, fires `onprogress` every 100 ms, advances playback in real time, and
accepts or refuses the crossfade writes.

**What that proves:** the extension's own logic, timing, state machine and
event sequence are correct against a faithful model of the client.

**What it does not prove:** that Spotify's internals behave the way the model
says. The simulator was built from the Spicetify source, the documented API
surface, and observed behaviour — not from instrumenting a running Spotify.

Anything below marked **untested on real Spotify** is exactly that. It is not a
hedge; it is the honest state of the evidence, and the reason `npm run playback`
exists is so a real session can be checked against the same assertions.

## The capability table

| Capability | Exists? | Works on current Spotify? | Works on Free? | How verified |
| --- | --- | --- | --- | --- |
| `Player.setVolume` / `PlaybackAPI.setVolume` | Yes | Yes | Yes | Simulator; documented API; used by Spicetify itself |
| `Player.next()` | Yes | Yes | Yes | Simulator; documented API |
| `Player.back()` | Yes | Yes | Yes | Documented API — **not used by Smart DJ** |
| `Player.seek()` | Yes | Yes | Yes | Simulator; documented API |
| `Player.getProgress()` / `getDuration()` | Yes | Yes | Yes | Simulator; interpolated from state timestamp |
| Playback state (`isPlaying`, `songchange`, `onplaypause`) | Yes | Yes | Yes | Simulator; documented API |
| Track metadata (`Player.data.item`) | Yes | Yes | Yes | Simulator; documented API |
| Queue read (`Queue.nextTracks`, `Player.data.nextItems`) | Yes | Yes | Yes | Simulator; documented API |
| Queue write (`addToQueue` / `removeFromQueue`) | Yes | Probably — internal (`Player.origin._queue`) | Unknown | **Untested on real Spotify.** Probed at runtime; off by default |
| Crossfade setting (write) | Yes, four undocumented paths | **Unknown** | **Probably not** — reports indicate Premium gating | **Untested on real Spotify.** Probed at runtime; the tier shown in the panel is the answer for your client |
| `audio-analysis` (beat grid, sections) | Yes, internal endpoint | Unknown per track | Unknown | **Untested on real Spotify.** Probed; disables itself after sustained failures |
| `audio-features` (energy, valence) | Yes, internal endpoint | Unknown | Unknown | **Untested on real Spotify.** Same treatment |
| Playback rate | `setSpeed` exists, podcasts only | No, for music | No | Spicetify docs; not called |
| Audio capture | No | No | No | No media element exists in the renderer |
| DSP | No | No | No | Audio is mixed below the web layer |
| EQ | No | No | No | Same |
| Per-track gain | No | No | No | One master fader |

## Real / conditional / approximated / impossible

**REAL** — actually changes playback, verified end to end in the simulator:

- Volume automation around the switch, with the user's level always restored
- Calling `next()` at a computed instant
- Seeking into the incoming track (fade path)
- Reading the queue and analysing what is coming
- Transition planning: cue points, lengths, strategy, refusal

**CONDITIONAL** — real where the client allows it, detected at runtime:

- Audio overlap via Spotify's own crossfade mixer, programmed per pair
- Queue reordering, and only for entries the user queued themselves
- Tempo, key and structure, per track, from the internal services

**APPROXIMATED** — produces a related effect by other means, labelled as such:

- Phrase and downbeat timing. The *timing* is exact; what it aligns is the
  moment of the switch, not two synchronised beat grids playing together.
- "Bass swap" shaping — a front-loaded broadband dip, not an EQ.
- Loudness matching — attenuating the incoming track, not per-deck gain.

**IMPOSSIBLE** — cannot be done from a Spicetify extension:

- Beatmatching (tempo warping), pitch shifting, EQ, filters, any DSP
- Independent gain on two overlapping tracks
- Waveform or live spectrum analysis
- Reordering playlist tracks without duplicating them

## The transition, step by step

### With crossfade available

```
Code calls ConfigAPI.setAccountSetting("audio.crossfade_v2", true)   ✓ verified
Code calls ConfigAPI.setAccountSetting("audio.crossfade.time_v2", N) ✓ verified
Code calls Player.next() at the phrase boundary                      ✓ verified
Spotify emits songchange                                             ✓ verified
Spotify's mixer overlaps the two streams                             ? untested on real Spotify
Listener hears an overlap                                            ? follows from the above
```

The last two steps are the ones that matter and the ones that cannot be
verified here. If they do not hold on your client, the panel's Compatibility
section will still say "Full DJ mode", because the writes were accepted — that
is the honest limit of what can be detected from inside the renderer.

### Without crossfade (Spotify Free)

```
Code dips the volume to ~30% over about one bar                      ✓ verified
Code calls Player.next() at the phrase boundary                      ✓ verified
Spotify emits songchange; the controller recognises it as ours       ✓ verified
Code waits for the client to report the new track                    ✓ verified
Code brings the level back over about one bar                        ✓ verified
Listener hears a tight switch rather than a gap                      ? untested on real Spotify
```

This is **not a mix**. It is a *phrase-timed cut with a dip to mask the gap*.
The dip is deliberately short and deliberately not to silence — see below.

## What changed after the real-playback investigation

### The controller was cancelling its own transitions

Spotify emits `songchange` for our own `next()` exactly as it does for a user
skip. The controller aborted unconditionally on that event, which killed every
transition roughly halfway through: the volume faded down, the track changed,
and the fade-in never ran.

What a listener heard was a track getting quieter and then snapping back to
full — which is precisely the reported symptom, and why it felt like "just
volume automation that does not restore properly".

The audio engine now marks that it is about to change track, and the controller
consults that before deciding whether the event is a user action.

### The fade was sized like an overlap

`durationSec` sizes how long two records may *sound together* — sixteen or
thirty-two beats, because that is what a mix wants. The fade path was using the
same number, producing about five seconds down to near-silence and three back.

That is eight seconds of music spent hiding a switch gap of roughly a tenth of
a second, and it is why it read as automation rather than as a transition. The
fade path now has its own geometry: about one bar down, to about 30% rather
than to silence, and about one bar back.

The *switch* is still placed on the phrase boundary. The level movement exists
only to mask the client's gap.

## Timing, shown rather than asserted

`npm run timing` prints where the engine puts the switch against the beat grid.
At 128 BPM with a 210-second track:

```
Grid:    1 beat = 0.4688s   1 bar = 1.875s   1 phrase (16 beats) = 7.500s

  blend length        7.50s = 16 beats = 4.0 bars
  SWITCH lands at     202.500s
    → beat            432.00  (ON the beat)
    → phrase          27, beat 0.00 of 16  (PHRASE ALIGNED)
    → time left in A  7.50s
  B's first downbeat lands at 202.500s — COINCIDES with A's downbeat
```

On the fade path the same switch instant is used, with the dip starting a bar
earlier so the cut itself lands on the boundary:

```
  fade-out STARTS at  201.562s  (lead-in 0.94s)
    so that next() is called exactly at 202.500s
```

## Running the checks yourself

```bash
npm run playback   # a real-time session against the simulator
npm run timing     # where the switch lands, per tempo
npm test           # the unit suite
```

In a real Spotify session, turn on Debug mode and use:

```js
SmartDJ.transitions()   // the event timeline of every transition this session
SmartDJ.explain()       // the current plan and every capability verdict
```

`SmartDJ.transitions()` prints the fixed event sequence for each transition and
warns about any that did not complete. If a transition stops halfway, its last
event says exactly where.
