# Troubleshooting

## The Smart DJ button is not in the player bar

**Check it is registered:**

```bash
spicetify config extensions
```

`smart-dj.js` should be in the list. If it is not:

```bash
spicetify config extensions smart-dj.js
spicetify apply
```

**Check the file is actually there.** Run `spicetify path userdata` and look for
`Extensions/smart-dj.js` inside that folder.

**Check the console.** In Spotify, press `Ctrl+Shift+I` (`Cmd+Option+I` on
macOS) to open developer tools, then look at the Console tab for lines starting
`[SmartDJ:boot]`. If you see an error there, it will say what went wrong.

**Spotify updated recently?** Spotify updates overwrite Spicetify's changes:

```bash
spicetify backup apply
```

Even without the button, the panel is reachable from the console:

```js
SmartDJ.open()
```

## It says "Fade mode — no audio overlap"

This is the expected result on a Free account with a recent Spotify build:
Spotify has moved the crossfade setting behind Premium, and Smart DJ drives that
setting to produce real overlap.

**Check whether you have it at all:** Spotify Settings → Playback → "Crossfade
songs". If that slider is not there, the capability genuinely is not available
and no extension can create it.

If the slider *is* there and Smart DJ still says fade mode, open the panel's
Compatibility section — it names which write path was tried and refused.

Fade mode is still doing real work: the switch lands on a phrase boundary,
levels are matched, and dead intros can be skipped (something the overlap path
cannot do). It is a well-timed switch rather than a mix.

## BPM and key show as `?`

The internal analysis services have no data for that track. This is common for
local files and for the long tail of the catalogue, and there is no way around
it from inside the client.

The engine still plans a transition — unknown data scores neutrally rather than
badly — but sizes it conservatively.

You can supply the values yourself from the console:

```js
SmartDJ.analyzer.setOverride(Spicetify.Player.data.item.uri, {
  tempo: 128,
  key: 9,    // pitch class: C=0, C#=1, D=2 … B=11
  mode: 0,   // 1 = major, 0 = minor
  energy: 0.8,
})
```

Overrides are stored locally and take priority over everything else.

## Transitions never fire

Check the status:

```js
SmartDJ.dj.getStatus()
```

These are all intended reasons for standing down:

| Reason | Why |
| --- | --- |
| repeat-one is on | looping one track is not a transition |
| track is under 25 seconds | too short to mix out of |
| the next two tracks are from the same album | album segues are left intact deliberately |
| already past the planned exit point | you seeked into the tail, or planning took too long |
| already transitioned out of this playthrough | it will fire again if you replay the track |

Turn on **Debug mode** in Advanced settings for a live heads-up display showing
what the engine is deciding and when.

## The transitions sound wrong

**Too early or too late on the beat?** Advanced → **Switch latency**. Your
client's delay between the call and the audio changing cannot be measured from
inside Spotify, so this is yours to dial in by ear. Positive values fire earlier.

**Too long?** Lower **Maximum length**, or switch DJ intent to *Energetic*,
which programmes shorter, more decisive switches.

**Too many mixes between tracks that do not fit?** Raise the **Blend floor**, or
use the *Smooth* intent, which refuses to mix rather than making a rough one.

**Not adventurous enough?** *Experimental* intent relaxes the technical
constraints and allows deliberate contrast cuts.

## The volume ended up somewhere odd

It should not — every ramp restores its baseline, and holds onto the original
level until the restore actually succeeds. Force it:

```js
SmartDJ.dj.audio.abort()
```

If you can reproduce this, please open an issue with the console output.

## Spotify feels slower

Smart DJ analyses each track once and caches the result. If something looks
wrong, check the numbers:

```js
SmartDJ.dj.diagnostics.snapshot()
SmartDJ.analyzer.cache.stats()
```

Clearing the cache is safe — it will be rebuilt as you listen:

```js
SmartDJ.analyzer.cache.clear()
```

## Turning it off without uninstalling

Untick **Enabled** at the top of the panel. Any transition in flight is stopped
and your volume restored. Spotify then behaves exactly as it would without the
extension.

## Reading what actually happened

Turn on Debug mode and open the panel's **Diagnostics** section. It shows how
many transitions were attempted, how many degraded to a lower tier, the average
score and confidence, and a full session log of every decision — what the engine
chose, why, and what happened.

"Copy session log" puts the whole thing on your clipboard. It stays on your
machine; nothing is sent anywhere.
