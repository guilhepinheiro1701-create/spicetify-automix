/**
 * Last-resort provider.
 *
 * When nothing knows anything about a track we still have to return something,
 * because the transition engine must always produce a plan. What we return is
 * deliberately marked low-confidence and carries no tempo or key at all — the
 * scoring layer treats missing data as *neutral*, not as incompatible, so a
 * track with no analysis gets a middle-of-the-road plan rather than a bad one.
 *
 * The only real signal here is duration, which tells us roughly what kind of
 * recording this is (an interlude, a radio edit, an extended mix).
 */

import type { AnalysisProvider } from "./types.js";
import type { TrackAnalysis, TrackRef } from "../../core/types.js";

export class HeuristicProvider implements AnalysisProvider {
  readonly id = "heuristic";
  readonly label = "Duration heuristics";

  isAvailable(): boolean {
    return true;
  }

  async fetch(track: TrackRef): Promise<TrackAnalysis> {
    const durationMs = track.durationMs || 0;
    const seconds = durationMs / 1000;

    // A 6-minute-plus track usually has a long, mixable intro and outro; a
    // sub-two-minute one usually does not. This only affects how much room the
    // engine gives itself, never the compatibility score.
    const startOfFadeOut = seconds > 30 ? Math.max(seconds - 12, seconds * 0.88) : undefined;

    return {
      uri: track.uri,
      source: "heuristic",
      confidence: 0.1,
      fetchedAt: Date.now(),
      durationMs,
      startOfFadeOut,
      endOfFadeIn: 0,
      beats: [],
      bars: [],
      sections: [],
      sectionEnergy: [],
      grid: null,
    };
  }
}
