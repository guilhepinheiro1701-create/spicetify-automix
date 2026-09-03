import type { TrackAnalysis, TrackRef } from "../../core/types.js";

export interface AnalysisProvider {
  readonly id: string;
  readonly label: string;
  /** Cheap synchronous check — is this provider usable at all right now? */
  isAvailable(): boolean;
  /** Resolve analysis, or null when this provider has nothing for the track. */
  fetch(track: TrackRef): Promise<TrackAnalysis | null>;
}

export interface ProviderHealth {
  id: string;
  attempts: number;
  hits: number;
  failures: number;
  lastError: string | null;
}
