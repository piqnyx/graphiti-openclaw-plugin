import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Cross-process ownership for the durable capture spool.
 *
 * OpenClaw hot reloads are handled by capture-runtime.ts inside one process, but
 * service restarts may briefly overlap two gateway processes. Without an OS-file
 * lease both processes can read the same durable head and independently deliver
 * it. The spool itself is atomic, but atomic replacement does not serialize two
 * writers. This lease does.
 *
 * A crashed owner leaves a lock file. The next process removes it only when the
 * recorded PID is demonstrably dead (or, on Linux, when the PID was reused with a
 * different /proc start marker). Ambiguity fails closed: refusing to capture is
 * preferable to having two writers manufacture two histories.
 */

type LeaseRecord = {
  version: 1;
  pid: number;
  token: string;
  acquiredAt: number;
  processStart?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function processStartMarker(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return undefined;
    // Fields after comm begin with field 3. starttime is field 22, therefore
    // index 19 in this suffix (0-based).
    const suffix = stat.slice(closeParen + 2).trim().split(/\s+/);
    return suffix[19];
  } catch {
    return undefined;
  }
}

function parseLease(text: string): LeaseRecord | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    if (!isObject(value) || value.version !== 1) return undefined;
    if (!Number.isInteger(value.pid) || (value.pid as number) <= 0) return undefined;
    if (typeof value.token !== "string" || value.token.length === 0) return undefined;
    if (typeof value.acquiredAt !== "number" || !Number.isFinite(value.acquiredAt)) return undefined;
    if (value.processStart !== undefined && typeof value.processStart !== "string") return undefined;
    return {
      version: 1,
      pid: value.pid as number,
      token: value.token,
      acquiredAt: value.acquiredAt,
      ...(typeof value.processStart === "string" ? { processStart: value.processStart } : {}),
    };
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = isObject(error) && typeof error.code === "string" ? error.code : "";
    if (code === "ESRCH") return false;
    // EPERM means the process exists but we cannot signal it. Any other answer is
    // ambiguous, so ownership is treated as live and capture fails closed.
    return true;
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export class CaptureLease {
  readonly path: string;
  private readonly token = randomUUID();
  private held = false;

  constructor(spoolPath: string) {
    this.path = `${spoolPath}.lock`;
  }

  acquire(): void {
    if (this.held) return;
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const record: LeaseRecord = {
        version: 1,
        pid: process.pid,
        token: this.token,
        acquiredAt: Date.now(),
        ...(processStartMarker(process.pid)
          ? { processStart: processStartMarker(process.pid) }
          : {}),
      };

      try {
        const fd = openSync(this.path, "wx", 0o600);
        try {
          writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        fsyncDirectory(dir);
        this.held = true;
        return;
      } catch (error) {
        const code = isObject(error) && typeof error.code === "string" ? error.code : "";
        if (code !== "EEXIST") throw error;
      }

      const existing = parseLease(readFileSync(this.path, "utf8"));
      if (!existing) {
        throw new Error(
          `Graphiti capture spool lease ${this.path} is malformed; refusing to guess whether another gateway owns it`,
        );
      }

      const alive = pidAlive(existing.pid);
      const currentStart = alive ? processStartMarker(existing.pid) : undefined;
      const sameProcessInstance =
        alive &&
        (!existing.processStart || !currentStart || existing.processStart === currentStart);
      if (sameProcessInstance) {
        throw new Error(
          `Graphiti capture spool ${this.path} is already owned by live gateway pid ${existing.pid}; refusing a second writer`,
        );
      }

      // Dead process, or a Linux PID that has demonstrably been reused. Rename
      // first so a forensic copy survives and so no stale owner file is silently
      // destroyed before the new exclusive create succeeds.
      const stalePath = `${this.path}.stale.${existing.pid}.${Date.now()}`;
      try {
        renameSync(this.path, stalePath);
        fsyncDirectory(dir);
      } catch (error) {
        const code = isObject(error) && typeof error.code === "string" ? error.code : "";
        if (code !== "ENOENT") throw error;
      }
    }

    throw new Error(`could not acquire Graphiti capture spool lease ${this.path}`);
  }

  release(): void {
    if (!this.held) return;
    try {
      if (!existsSync(this.path)) {
        this.held = false;
        return;
      }
      const existing = parseLease(readFileSync(this.path, "utf8"));
      if (!existing || existing.token !== this.token) {
        throw new Error(
          `Graphiti capture spool lease ${this.path} changed ownership; refusing to unlink another owner's lock`,
        );
      }
      unlinkSync(this.path);
      fsyncDirectory(dirname(this.path));
      this.held = false;
    } catch (error) {
      const code = isObject(error) && typeof error.code === "string" ? error.code : "";
      if (code === "ENOENT") {
        this.held = false;
        return;
      }
      throw error;
    }
  }

  isHeld(): boolean {
    return this.held;
  }
}
