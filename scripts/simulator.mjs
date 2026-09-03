/**
 * A Spotify client simulator that behaves like the real thing.
 *
 * The unit and smoke suites never caught the bug that made Smart DJ useless in
 * practice, because neither of them modelled the one behaviour that matters:
 * **calling `next()` makes Spotify emit `songchange`**. Our own track change
 * therefore looked identical to the user pressing skip.
 *
 * This simulator emits the events a real client emits, with realistic latency,
 * and drives playback position forward in (accelerated) real time. Anything
 * that passes here has been through the actual sequence of events a listening
 * session produces.
 *
 * It is deliberately dumb about audio — it cannot tell you whether a mix sounds
 * good. What it can tell you is whether the volume came back.
 */

export class SpotifySimulator {
  /**
   * @param {object} options
   * @param {number} [options.switchLatencyMs] how long `next()` takes to take effect
   * @param {number} [options.progressIntervalMs] how often onprogress fires
   * @param {boolean} [options.crossfadeWritable] whether the crossfade setting accepts writes
   * @param {"premium"|"free"} [options.productType]
   * @param {(id: string) => object | null} [options.featuresFor]
   */
  constructor(options = {}) {
    this.switchLatencyMs = options.switchLatencyMs ?? 120;
    this.progressIntervalMs = options.progressIntervalMs ?? 100;
    this.crossfadeWritable = options.crossfadeWritable ?? false;
    this.productType = options.productType ?? "free";
    this.featuresFor = options.featuresFor ?? (() => null);

    /** @type {{uri: string, name: string, durationMs: number, analysis: object, albumUri: string, provider: string}[]} */
    this.playlist = [];
    this.index = 0;
    this.positionMs = 0;
    this.playing = false;
    this.volume = 0.8;
    this.repeat = 0;

    /** Everything the extension did, in order, with timestamps. */
    this.events = [];
    /** @type {Record<string, ((e: unknown) => void)[]>} */
    this.listeners = {};

    this.crossfadeSettings = { enabled: false, durationMs: 0 };
    this.nextCalls = 0;
    this.seekCalls = [];
    this.volumeWrites = [];

    this.clock = null;
    this.startedAt = 0;
  }

  // ── Timeline ──────────────────────────────────────────────────────────────

  record(type, detail = {}) {
    this.events.push({
      at: Date.now() - this.startedAt,
      positionMs: Math.round(this.positionMs),
      track: this.current()?.name ?? "—",
      volume: Number(this.volume.toFixed(3)),
      type,
      ...detail,
    });
  }

  current() {
    return this.playlist[this.index] ?? null;
  }

  upcoming() {
    return this.playlist.slice(this.index + 1);
  }

  emit(event, data) {
    for (const fn of this.listeners[event] ?? []) {
      try {
        fn({ data });
      } catch (err) {
        this.record("LISTENER_THREW", { event, error: String(err) });
      }
    }
  }

  /**
   * Run the session.
   *
   * `speed` defaults to 1, and should stay there for any test that touches the
   * volume: `VolumeAutomation` and the scheduler run on real timers, so
   * compressing simulated playback makes a track end mid-fade and measures an
   * artifact rather than the product.
   */
  async run({ startAtMs = 0, forMs = 60_000, speed = 1, tickMs = 25 } = {}) {
    this.startedAt = Date.now();
    this.positionMs = startAtMs;
    this.playing = true;
    this.record("SESSION_START");

    let sinceProgress = 0;
    const realTickMs = Math.max(1, Math.round(tickMs / speed));
    const virtualTick = tickMs;

    for (let elapsed = 0; elapsed < forMs; elapsed += virtualTick) {
      await new Promise((r) => setTimeout(r, realTickMs));
      if (!this.playing) continue;

      this.positionMs += virtualTick;
      sinceProgress += virtualTick;

      if (sinceProgress >= this.progressIntervalMs) {
        sinceProgress = 0;
        this.emit("onprogress", this.positionMs);
      }

      // A track that runs out advances on its own, exactly as Spotify does.
      const track = this.current();
      if (track && this.positionMs >= track.durationMs) {
        this.record("TRACK_ENDED_NATURALLY");
        this.advance("natural end");
      }
    }

    this.record("SESSION_END");
    return this.events;
  }

  advance(cause) {
    if (this.index >= this.playlist.length - 1) {
      this.playing = false;
      this.record("QUEUE_EXHAUSTED", { cause });
      return;
    }
    this.index++;
    this.positionMs = 0;
    this.record("TRACK_CHANGED", { cause, to: this.current()?.name });
    // This is the line that broke everything: the real client emits songchange
    // for OUR next() just as it does for the user's skip.
    this.emit("songchange", this.current());
  }

  // ── The Spicetify surface ─────────────────────────────────────────────────

  buildGlobal() {
    const sim = this;
    const trackObj = (t) =>
      t
        ? {
            uri: t.uri,
            id: t.uri.split(":")[2],
            name: t.name,
            artists: [{ name: t.artist ?? "Artist" }],
            album: { uri: t.albumUri },
            duration: { milliseconds: t.durationMs },
            provider: t.provider ?? "context",
            metadata: {},
          }
        : null;

    const configApi = sim.crossfadeWritable
      ? {
          _s: {},
          async setAccountSetting(key, value) {
            configApi._s[key] = value;
            if (key === "audio.crossfade_v2") sim.crossfadeSettings.enabled = Boolean(value);
            if (key === "audio.crossfade.time_v2") sim.crossfadeSettings.durationMs = Number(value);
            sim.record("CROSSFADE_WRITE", { key, value });
          },
          async getAccountSetting(key) {
            return configApi._s[key];
          },
        }
      : undefined;

    const rejectCosmos = async () => {
      throw new Error("Resolver not found");
    };

    return {
      Player: {
        get data() {
          const t = trackObj(sim.current());
          return {
            item: t,
            nextItems: sim.upcoming().map(trackObj),
            isPaused: !sim.playing,
            duration: sim.current()?.durationMs ?? 0,
          };
        },
        getProgress: () => sim.positionMs,
        getDuration: () => sim.current()?.durationMs ?? 0,
        isPlaying: () => sim.playing,
        getRepeat: () => sim.repeat,
        setVolume: (v) => {
          sim.volume = v;
          sim.volumeWrites.push(Number(v.toFixed(3)));
        },
        getVolume: () => sim.volume,
        next: () => {
          sim.nextCalls++;
          sim.record("NEXT_CALLED");
          // Real clients do not switch instantly.
          setTimeout(() => sim.advance("next() from extension"), sim.switchLatencyMs);
        },
        seek: (ms) => {
          sim.seekCalls.push(ms);
          sim.positionMs = ms;
          sim.record("SEEK", { ms });
        },
        addEventListener: (event, fn) => {
          (sim.listeners[event] ??= []).push(fn);
        },
        removeEventListener: (event, fn) => {
          sim.listeners[event] = (sim.listeners[event] ?? []).filter((f) => f !== fn);
        },
      },
      Platform: {
        PlaybackAPI: {
          setVolume: (v) => {
            sim.volume = v;
            sim.volumeWrites.push(Number(v.toFixed(3)));
          },
          get _volume() {
            return sim.volume;
          },
        },
        PlayerAPI: {},
        ...(configApi ? { ConfigAPI: configApi } : {}),
        UserAPI: {
          _product_state: {
            getValues: async () => ({ pairs: { type: sim.productType } }),
          },
        },
        PlatformData: { client_version_triple: "1.2.99.0", os_name: "linux" },
      },
      CosmosAsync: {
        get: async (url) => {
          const m = /audio-features\/([A-Za-z0-9]+)/.exec(String(url));
          if (m) {
            const f = sim.featuresFor(m[1]);
            if (f) return f;
            throw new Error("404 no features");
          }
          return {};
        },
        post: rejectCosmos,
        put: rejectCosmos,
      },
      get Queue() {
        return {
          nextTracks: sim.upcoming().map(trackObj),
          prevTracks: [],
          queueRevision: String(sim.index),
          track: trackObj(sim.current()),
        };
      },
      URI: {
        Type: { TRACK: "track" },
        from: (u) => ({ Type: "track", getBase62Id: () => String(u).split(":")[2] }),
      },
      LocalStorage: {
        _m: new Map(),
        get(k) {
          return this._m.get(k) ?? null;
        },
        set(k, v) {
          this._m.set(k, v);
        },
      },
      Playbar: {
        Button: class {
          constructor(label) {
            this.label = label;
          }
          deregister() {}
        },
      },
      PopupModal: { display: () => {} },
      showNotification: () => {},
      getAudioData: async (uri) => {
        const t = sim.playlist.find((x) => x.uri === uri);
        if (!t?.analysis) throw new Error("no analysis");
        return t.analysis;
      },
      addToQueue: async () => {},
      removeFromQueue: async () => {},
    };
  }
}

/** A plausible audio-analysis payload. */
export function analysisPayload(bpm, key, mode, durationSec, loudness, introSec, outroSec) {
  const spb = 60 / bpm;
  const bodyEnd = durationSec - outroSec;
  const sections = [];
  const push = (start, duration, loud) => {
    if (duration <= 0.5) return;
    sections.push({
      start,
      duration,
      confidence: 0.85,
      loudness: loud,
      tempo: bpm,
      key,
      mode,
      time_signature: 4,
    });
  };
  if (introSec > 0) push(0, introSec, loudness - 12);
  const bodyLen = bodyEnd - introSec;
  for (let i = 0; i < 3; i++) push(introSec + (i * bodyLen) / 3, bodyLen / 3, loudness);
  if (outroSec > 0) push(bodyEnd, outroSec, loudness - 12);

  return {
    track: {
      duration: durationSec,
      tempo: bpm,
      tempo_confidence: 0.9,
      time_signature: 4,
      key,
      mode,
      key_confidence: 0.85,
      loudness,
      end_of_fade_in: introSec > 0 ? 0.5 : 0,
      start_of_fade_out: bodyEnd,
    },
    beats: Array.from({ length: Math.floor(durationSec / spb) }, (_, i) => ({
      start: i * spb,
      duration: spb,
      confidence: 0.9,
    })),
    bars: Array.from({ length: Math.floor(durationSec / (spb * 4)) }, (_, i) => ({
      start: i * spb * 4,
      duration: spb * 4,
      confidence: 0.85,
    })),
    sections,
    segments: Array.from({ length: 400 }, (_, i) => ({
      start: (i * durationSec) / 400,
      duration: durationSec / 400,
      loudness_start: loudness - 16,
      loudness_max: loudness,
      timbre: [40, bpm > 120 ? 90 : -50, 5],
    })),
  };
}

/** Minimal DOM so the extension's UI layer can load. */
export function stubDom() {
  const mkEl = (tag) => {
    const el = {
      tagName: tag,
      children: [],
      attrs: {},
      style: {},
      className: "",
      textContent: "",
      innerHTML: "",
      disabled: false,
      value: "",
      append: (...c) => el.children.push(...c),
      appendChild: (c) => (el.children.push(c), c),
      setAttribute: (k, v) => (el.attrs[k] = String(v)),
      getAttribute: (k) => el.attrs[k] ?? null,
      addEventListener: () => {},
      removeEventListener: () => {},
      replaceWith: () => {},
      remove: () => {},
    };
    return el;
  };
  globalThis.document = {
    createElement: mkEl,
    createTextNode: (t) => ({ text: t }),
    head: mkEl("head"),
    body: mkEl("body"),
  };
  globalThis.localStorage = {
    _m: new Map(),
    getItem(k) {
      return this._m.get(k) ?? null;
    },
    setItem(k, v) {
      this._m.set(k, v);
    },
  };
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  // `navigator` is a getter-only global in Node; the panel only ever reads
  // `navigator.clipboard?.writeText`, which is safely undefined here.
}
