/**
 * Shared plumbing for the Spotify client's internal `audio-attributes` service.
 *
 * Both the audio-analysis and audio-features providers talk to undocumented
 * endpoints on `spclient.wg.spotify.com` through Cosmos, using the client's own
 * session. They fail in the same ways — a track with no data returns an error
 * that looks exactly like the endpoint having been removed — so they share the
 * same policy: tolerate individual misses, but stop asking once a long unbroken
 * run of failures says the endpoint itself is gone.
 */

import { createLogger, type Logger } from "../../core/logger.js";
import { cosmosGet } from "../../platform/spicetify.js";

/** A handful of misses is normal; this many in a row means the endpoint is gone. */
const DEAD_AFTER_CONSECUTIVE_FAILURES = 12;

export class InternalEndpoint {
  private dead = false;
  private consecutiveFailures = 0;
  private hits = 0;
  private readonly log: Logger;

  constructor(
    /** Scope name for logging, e.g. "audio-features". */
    readonly name: string,
    /** Builds the URL for a base62 track id. */
    private readonly urlFor: (id: string) => string,
  ) {
    this.log = createLogger(`provider:${name}`);
  }

  get isAlive(): boolean {
    return !this.dead;
  }

  /** True once this endpoint has ever returned usable data on this client. */
  get hasEverWorked(): boolean {
    return this.hits > 0;
  }

  markDead(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    this.log.warn(`disabled for this session: ${reason}`);
  }

  reset(): void {
    this.dead = false;
    this.consecutiveFailures = 0;
  }

  /** Fetch and parse, or null. Never throws. */
  async fetch<T>(id: string): Promise<T | null> {
    if (this.dead) return null;
    try {
      const body = (await cosmosGet(this.urlFor(id))) as T;
      if (!body || typeof body !== "object") {
        this.noteFailure("empty response");
        return null;
      }
      this.consecutiveFailures = 0;
      this.hits++;
      return body;
    } catch (err) {
      this.noteFailure(String((err as Error)?.message ?? err));
      return null;
    }
  }

  private noteFailure(message: string): void {
    this.consecutiveFailures++;
    this.log.debug(`miss (${this.consecutiveFailures}): ${message}`);
    if (this.consecutiveFailures >= DEAD_AFTER_CONSECUTIVE_FAILURES) {
      this.markDead(
        `${DEAD_AFTER_CONSECUTIVE_FAILURES} consecutive failures — the endpoint has probably been removed`,
      );
    }
  }
}
