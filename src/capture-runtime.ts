/**
 * Process-wide ownership of the capture runtime.
 *
 * OpenClaw calls register() several times per process — once per host surface —
 * and may call it again on a plugin hot reload. Each call used to build its own
 * BufferEngine over the same durable spool, so a start with unsent messages gave
 * every instance the same buffer and every instance flushed it: one batch became
 * several episodes with the same name and different UUIDs.
 *
 * The capture pipeline is therefore owned per process, not per registration.
 * Every registration binds its hooks to the same runtime, so it does not matter
 * which host surface actually delivers events.
 *
 * State lives on a global symbol rather than in module scope because a hot
 * reload can re-import the module, which would otherwise hand the new copy a
 * fresh, empty registry while the previous engines keep running.
 */
const RUNTIME_KEY = Symbol.for("graphiti-openclaw-plugin/capture-runtime.v1");

type RuntimeSlot<T> = {
  fingerprint: string;
  value: T;
};

type RuntimeHost<T> = {
  [RUNTIME_KEY]?: RuntimeSlot<T>;
};

export type AcquireOutcome = "created" | "reused" | "replaced_stopped" | "replaced_reconfigured";

export type AcquireResult<T> = {
  runtime: T;
  outcome: AcquireOutcome;
};

/**
 * Return the process-wide runtime, creating it only when there is none, when the
 * previous one has been shut down, or when the plugin configuration changed.
 *
 * A configuration change deliberately replaces the runtime instead of silently
 * reusing one built from different settings.
 */
export function acquireCaptureRuntime<T>(params: {
  fingerprint: string;
  isStopped: (runtime: T) => boolean;
  create: () => T;
  dispose?: (runtime: T) => void;
}): AcquireResult<T> {
  const host = globalThis as RuntimeHost<T>;
  const existing = host[RUNTIME_KEY];

  if (existing) {
    if (existing.fingerprint !== params.fingerprint) {
      params.dispose?.(existing.value);
      const runtime = params.create();
      host[RUNTIME_KEY] = { fingerprint: params.fingerprint, value: runtime };
      return { runtime, outcome: "replaced_reconfigured" };
    }
    if (!params.isStopped(existing.value)) {
      return { runtime: existing.value, outcome: "reused" };
    }
    const runtime = params.create();
    host[RUNTIME_KEY] = { fingerprint: params.fingerprint, value: runtime };
    return { runtime, outcome: "replaced_stopped" };
  }

  const runtime = params.create();
  host[RUNTIME_KEY] = { fingerprint: params.fingerprint, value: runtime };
  return { runtime, outcome: "created" };
}

/** Test-only: forget the process-wide runtime without touching the instance. */
export function resetCaptureRuntimeForTests(): void {
  delete (globalThis as RuntimeHost<unknown>)[RUNTIME_KEY];
}
