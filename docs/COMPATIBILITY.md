# Compatibility

## What Smart DJ detects at startup

`probeCapabilities()` runs once when the extension loads and produces the
compatibility report shown in the panel:

```
SMART DJ COMPATIBILITY
Spicetify 2.33.2 · Spotify 1.2.81.264 · linux · account free

⚠ Beat grid, bars and sections     per-track availability confirmed on first use
⚠ Energy, valence and danceability internal service reachable
❌ Real audio overlap              no write path accepted — recent builds gate
                                   crossfade behind Premium
⚠ Volume automation                master volume only, not per-track gain
✅ Next-track lookahead            queue readable before playback
⚠ Queue reordering                 only entries you queued yourself can move
✅ Millisecond playback position   interpolated from the state timestamp
❌ Playback-rate change            no playback-rate API for music
❌ EQ, filters and effects         no DSP hook exists
❌ Independent gain per track      one master fader, not two
```

`⚠` means "works, with a documented caveat" — not "might not work".

## Client versions

| Component | What is read | Where from |
| --- | --- | --- |
| Spicetify | `Spicetify.Config.version` | the injected global |
| Spotify | `Platform.PlatformData.client_version_triple` | the client |
| OS | `Platform.PlatformData.os_name` | the client |
| Account | `UserAPI._product_state` (three known names probed) | the client |

All of these are optional. A missing version string is displayed as absent, not
guessed at.

## Which APIs Smart DJ depends on

Documented, stable:

| API | Used for |
| --- | --- |
| `Player.getProgress/getDuration/isPlaying` | scheduling |
| `Player.next` / `Player.seek` | the switch, and intro skipping |
| `Player.addEventListener` | songchange, playpause |
| `Platform.PlaybackAPI.setVolume` | the fade path |
| `Queue.nextTracks` / `Player.data.nextItems` | lookahead |
| `Playbar.Button`, `PopupModal` | the UI |
| `LocalStorage` | settings, caches |

Undocumented and version-dependent — each is probed, and its absence degrades
rather than breaks:

| API | If it goes |
| --- | --- |
| `Spicetify.getAudioData` | no beat grid; conservative lengths, no phrase alignment |
| `spclient…/audio-features` | derived energy takes over |
| `Platform.ConfigAPI.setAccountSetting` | one of four crossfade paths |
| `Platform.PlayerAPI._prefs.setCrossfade` | one of four |
| `sp://player/v2/main`, `sp://connect/v1/…` | two of four |
| `Platform.UserAPI._product_state` | account tier shows as unknown |
| `Player.origin._queue` (via `addToQueue`) | reordering unavailable; analysis unaffected |

## When Spotify changes

Two things make a client update survivable.

**Everything is probed, never assumed.** Modules ask the capability layer, which
asked the client. There is no code path that calls an API without the layer
having confirmed it exists.

**The ladder always terminates.** The bottom rung is passive, which requires
nothing and does nothing. Whatever disappears, the worst outcome is Spotify
behaving exactly as it would without the extension.

Degradations are counted, so a change shows up as a number rather than a
mystery:

```js
SmartDJ.dj.diagnostics.snapshot().degraded
```

## Known behaviour by account type

| | Premium | Free |
| --- | --- | --- |
| Real audio overlap | usually available | usually gated — see below |
| Track analysis | yes | yes (same internal services) |
| Phrase and downbeat timing | yes | yes |
| Loudness matching | fade path only | yes |
| Intro skipping | fade path only | yes |
| Queue reordering | user-queued entries | user-queued entries |

Community reports through 2026 indicate recent desktop builds moved the
crossfade setting behind Premium. Since Smart DJ produces overlap by driving
that setting, Free accounts on those builds get the **Phrase-Timed Fade** path.
That path got
specific attention in Phase 2 and is genuinely good — see
[LIMITATIONS.md](LIMITATIONS.md) — but it is not an overlap and is never
described as one.

## Checking your own client

```js
SmartDJ.dj.getCapabilities()        // the full report with reasons
SmartDJ.dj.getCapabilities().flags  // the boolean view
SmartDJ.explain()                   // the current plan and every verdict
SmartDJ.dj.diagnostics.snapshot()   // what has happened this session
```

If a capability is missing that you expect to have, the `reason` field says
which check failed, and `detail` says what was tried.
