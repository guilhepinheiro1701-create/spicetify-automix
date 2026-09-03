# The algorithm

This is the reasoning behind the numbers in `src/engine/` and `src/music/`. Every
threshold here comes from DJ practice rather than from taste, and the tests in
`tests/` pin the behaviour those thresholds produce.

## 1. Scoring: what makes two tracks fit

```
tempo     30%
key       22%
energy    18%
phrase    15%
loudness   9%
style      6%
```

The order follows the order a DJ works in.

**Tempo, 30%.** The hard constraint. Two tracks at incompatible tempos cannot be
blended at all — and because this client offers no rate control, we cannot fix a
mismatch by pitching a deck. Tempo therefore carries *more* weight here than it
would in a tool that could beatmatch, because a mismatch is unfixable rather than
merely inconvenient.

**Key, 22%.** Clashing keys during an overlap is the most viscerally wrong thing
a mix can do. Second only to tempo.

**Energy, 18%.** What separates a programmed set from a shuffle.

**Phrase, 15%.** Deliberately below key. A phrase-perfect transition between
clashing keys still sounds wrong; a slightly-off transition between compatible
tracks mostly does not.

**Loudness, 9%.** Catches level jumps, which read as a mistake rather than a
choice.

**Style, 6%.** A light nudge from shared artists and derived timbre. Genre tags
are not exposed to extensions, so this is the best signal available.

### Unknown data is neutral, never a penalty

Every component returns `0.5` with `confidence: 0` when its inputs are missing.
An unanalysed track scores like an average one, not a bad one, and the report
carries a separate `confidence` figure so the UI can say "we are guessing".

This matters more than it sounds: the internal analysis service has no data for a
large slice of the catalogue. Treating "unknown" as "incompatible" would make the
extension refuse to mix most of a real library.

## 2. Tempo

```
|Δ| ≤ 3%    1.00 → 0.94    comfortable — the mix just works
|Δ| ≤ 6%    0.94 → 0.76    the vinyl pitch-fader window
|Δ| ≤ 8%    0.76 → 0.62    outer limit of same-genre mixing
|Δ| ≤ 20%   0.62 → 0.10    creative-transition territory
|Δ| > 20%   → ~0           nothing blends here
```

±6% is the classic vinyl pitch range and is also, not coincidentally, about one
semitone of pitch shift. ±8% is the usual practical limit within a genre.

**Half and double time.** 70 → 140 BPM is a real and common technique, so the
matcher folds A's tempo by ×2 and ÷2 and keeps whichever reading fits best. A
folded match is multiplied by 0.94, so a direct match always wins at equal error.

**The reported adjustment.** `bpmAdjustmentPercent` is the change that *would*
beatmatch the pair. It is computed, shown in the debug panel, and
`bpmAdjustmentApplied` is hard-coded `false` — there is no rate control for
music, and the plan says so in its caveats.

## 3. Key — the Camelot wheel

The 24 keys map onto 1–12 with `A` for minor and `B` for major, arranged so that
neighbours are a perfect fifth apart.

| Relation | Example | Score |
| --- | --- | --- |
| Same key | 8A → 8A | 1.00 |
| Relative major/minor | 8A → 8B | 0.92 |
| One step, same letter | 8A → 9A / 7A | 0.88 |
| +2 "energy boost" | 8A → 10A | 0.62 |
| −2 | 8A → 6A | 0.55 |
| One step *and* a letter change | 8A → 9B | 0.42 |
| Anything else | 8A → 2B | 0.34 decaying to 0.05 |

The scores are not linear in wheel distance on purpose. DJs treat the three
"perfect" moves as interchangeable and everything past +2 as a clash, regardless
of how far around the wheel it happens to be. The decay past that point only
exists so ordering stays sensible.

## 4. Energy

Peak at **+0.04** — a gentle lift. Tolerance is asymmetric (0.22 up, 0.18 down)
because sets build; a drop needs more justification than a rise. Past **±0.45**
the score is capped at 0.12 no matter what the curve says, because 0.25 → 0.95
is not a transition, it is a collision.

Energy is *derived*, not read. Spotify's `energy` feature went away with the
audio-features endpoint, so `src/analysis/features.ts` rebuilds it from the
segment and beat data:

```
energy = 0.45 · P75(segment energy)   ← how hard the track goes
       + 0.20 · mean(segment energy)  ← how consistently
       + 0.20 · tempo, normalised
       + 0.15 · pulse strength
```

where per-segment energy combines peak level (55%), attack — the jump from onset
to peak, which is what makes a hit percussive (20%), and spectral brightness from
timbre coefficient 1 (25%).

The 75th percentile rather than the mean is the important choice: a two-minute
ambient intro should not make a banger read as calm.

## 5. Phrase matching

Dance and pop music is written in 4-beat bars grouped into 8, 16 and 32-beat
phrases. The beat grid tells us where beats are but not where a *phrase* starts —
that phase has to be recovered.

The method: test every bar offset within one phrase, and keep the one whose
phrase lines best agree with the section boundaries the analysis already found.
Sections are where the arrangement actually changes, so a grid that agrees with
them is the grid the producer wrote to. The residual error becomes the grid's
confidence, which then scales the phrase component of every score that uses it.

A tempo with no beat list still yields a grid, anchored at zero with confidence
0.2 — enough to reason about phrase *lengths* without claiming to know where the
downbeats fall.

## 6. Cue points

**Exit — where we leave track A.** Three candidate sources, in descending
musical authority:

1. `start_of_fade_out` from the analysis. Nothing beats the mastering engineer.
2. Section boundaries in the back half, weighted up when energy drops across them
   (an outro is a natural place to leave).
3. Phrase-grid lines near the ideal exit.

Each is scored on `strength · 0.55 + proximity · 0.45`, where proximity measures
distance from the point at which the blend would finish exactly as the track's
material runs out. Overrunning is penalised 1.6× harder than leaving early. The
winner is then snapped to the nearest downbeat.

**Entry — where we come into track B.** Usually 0. Dropping into the middle of a
track is a strong move that only pays off when the opening is genuinely dead air,
so we skip only when the first sections measure below 55% of the track's peak
energy, cap the skip at 30 s (or a quarter of the track), and land on a downbeat.

Intro skipping needs a seek after the switch, which cannot happen mid-overlap —
so it is available on the fade path only, and the plan says so.

## 7. Choosing a technique

```
same album, consecutive?          → gapless-passthrough   (do nothing, on purpose)
no crossfade AND no volume?       → hard-cut              (stand down)
compatibility < blend floor?      → fade-cut
|Δtempo| > 12%?                   → quick-blend or fade-cut
no overlap available?             → fade-cut (volume-fade executor)
compat ≥ 0.72, grids, |Δ| ≤ 6%?   → beat-aligned-blend
compat ≥ 0.55?                    → phrase-blend
otherwise                         → quick-blend
```

Two of these are worth calling out.

**Album segues are sacred.** Two consecutive tracks the artist sequenced to run
together must not be crossfaded. Doing nothing is the musically correct answer,
and it is the default.

**Refusing is a feature.** Below the blend floor the engine will not overlap. The
brief's own bad example — 90 BPM in C major into 145 BPM in F♯ minor — has no
good long transition, and producing one anyway would be worse than a clean
switch. This is the difference between a DJ and a crossfade slider.

## 8. Sizing the blend

```
beats = base(technique, style)
      × (0.6 + intensity × 0.8)             ← the user's thumb on the scale
      × (1 − (1 − compat) × sensitivity × 0.7)  ← the engine's
      × style.lengthBias
```

then snapped to a phrase length (4/8/16/32/64), converted to seconds at track A's
tempo, and clamped by: the style's own bounds, then the user's min/max, then
Spotify's 12 s crossfade ceiling on the overlap path, then a fifth of the track's
length. Finally it is rounded to a whole number of bars so the blend resolves
musically.

The compatibility term is what makes a mediocre pair get a short transition
automatically, without the user having to notice.

## 9. What the plan honestly cannot do

Three fields exist specifically to stop the code from lying:

- `bpmAdjustmentApplied: false` — always. The adjustment is reported, never
  applied.
- `eq.approximated: true` — whenever EQ is enabled. There is no per-band control.
  On the fade path the intent is approximated by front-loading the fade
  (exponential rather than equal-power), which clears the outgoing track out of
  the way sooner. That is the same *gesture* as a bass swap, applied broadband.
  During a native overlap it cannot be applied at all, and the plan says so.
- `gain.perTrackSupported: false` — one master fader exists, not two.

Every one of these is asserted in `tests/fallback.test.ts`, so no future change
can quietly start claiming a capability that does not exist.
