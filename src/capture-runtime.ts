/**
 * Process-wide ownership of the capture runtime.
 *
 * OpenClaw calls register() several times per process and may call it again on a
 * hot reload. There must still be exactly one owner of the durable capture spool
 * and exactly one BufferEngine consuming it. Two live runtimes over one spool can
 * both observe the same restored head and manufacture different sequence state,
 * which is a direct route to duplicated or reordered episodes.
 *
 * State lives on a global symbol rather than in module scope because a hot reload
 * can re-import this module while the previous copy is still alive.
 */
const RUNTIME_KEY = Symbol.for("graphiti-openclaw-plugin/capture-runtime.v1");

type RuntimeSlot<T> = {
  fingerprint: string;
  value: T;
};

type RuntimeHost<T> = {
  [RUNTIME_KEY]?: RuntimeSlot<T>;
};

export type AcquireOutcome =
  | "created"
  | "reused"
  | "reused_config_mismatch"
  | "replaced_stopped"
  | "replaced_reconfigured";

export type AcquireResult<T> = {
  runtime: T;
  outcome: AcquireOutcome;
};

/**
 * Return the single process-wide runtime.
 *
 * A live runtime is NEVER replaced merely because a hot reload presents a new
 * configuration fingerprint. Replacing it would orphan its timers/in-flight
 * delivery while a second runtime starts consuming the same durable spool. The
 * current runtime therefore remains authoritative until it is stopped; changed
 * capture configuration takes effect on the next clean runtime creation.
 */
export function acquireCaptureRuntime<T>(params: {
  fingerprint: string;
  isStopped: (runtime: T) => boolean;
  create: () => T;
}): AcquireResult<T> {
  const host = globalThis as RuntimeHost<T>;
  const existing = host[RUNTIME_KEY];

  if (existing) {
    if (!params.isStopped(existing.value)) {
      return {
        runtime: existing.value,
        outcome:
          existing.fingerprint === params.fingerprint ? "reused" : "reused_config_mismatch",
      };
    }

    const runtime = params.create();
    const sameConfiguration = existing.fingerprint === params.fingerprint;
    host[RUNTIME_KEY] = { fingerprint: params.fingerprint, value: runtime };
    return {
      runtime,
      outcome: sameConfiguration ? "replaced_stopped" : "replaced_reconfigured",
    };
  }

  const runtime = params.create();
  host[RUNTIME_KEY] = { fingerprint: params.fingerprint, value: runtime };
  return { runtime, outcome: "created" };
}

/** Test-only: forget the process-wide runtime without touching the instance. */
export function resetCaptureRuntimeForTests(): void {
  delete (globalThis as RuntimeHost<unknown>)[RUNTIME_KEY];
}
