/** Namespaced logger with a runtime-toggleable level and a ring buffer for the debug panel. */

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export interface LogEntry {
  at: number;
  level: Exclude<LogLevel, "silent">;
  scope: string;
  message: string;
}

const RING_SIZE = 200;
const ring: LogEntry[] = [];
let level: LogLevel = "warn";

export function setLogLevel(next: LogLevel): void {
  level = next;
}

export function getLogLevel(): LogLevel {
  return level;
}

export function getLogBuffer(): readonly LogEntry[] {
  return ring;
}

export function clearLogBuffer(): void {
  ring.length = 0;
}

function emit(entryLevel: Exclude<LogLevel, "silent">, scope: string, args: unknown[]): void {
  const message = args
    .map((a) => {
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");

  ring.push({ at: Date.now(), level: entryLevel, scope, message });
  if (ring.length > RING_SIZE) ring.shift();

  if (ORDER[level] < ORDER[entryLevel]) return;
  const tag = `%c[SmartDJ:${scope}]`;
  const style = "color:#1ed760;font-weight:600";
  const fn =
    entryLevel === "error"
      ? console.error
      : entryLevel === "warn"
        ? console.warn
        : console.log;
  fn(tag, style, ...args);
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (...a) => emit("debug", scope, a),
    info: (...a) => emit("info", scope, a),
    warn: (...a) => emit("warn", scope, a),
    error: (...a) => emit("error", scope, a),
  };
}
