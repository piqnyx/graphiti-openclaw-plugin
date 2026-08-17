/**
 * Batches submitted to Graphiti but not yet seen in the graph.
 *
 * Graphiti answers "queued" the moment it takes a batch, and does the work later:
 * entity extraction runs through an LLM, and the episode node appears only when
 * that finishes. Treating acceptance as success meant a batch was dropped from
 * the spool while the backend still had every chance to fail — and when the model
 * was unreachable for half an hour, that is exactly what happened: batches were
 * accepted, never persisted, and their messages are gone.
 *
 * So acceptance now means "handed over", not "done". A batch stays here until its
 * episode is found in the graph; if it is still missing after a grace period, it
 * is submitted again.
 *
 * Resubmission is safe because episode uuids are derived from the batch content
 * and the server merges on uuid: sending the same batch twice lands on the same
 * node. With the random uuids this project used to generate, a retry would have
 * created a second copy — the very damage this guards against.
 *
 * The tracker holds no opinion about when to check or how to submit; it records
 * what is outstanding and answers what is due. Bounded on purpose: an outage must
 * cost a bounded amount of disk, and being over the bound is itself something the
 * status tool reports rather than something to hide.
 */

/**
 * The key a session's numbering is tracked under.
 *
 * Written as an explicit escape because the separator matters: a session key may
 * contain colons, slashes and spaces, so joining on any of those could let two
 * different pairs collide. A NUL cannot appear in either part.
 */
export function sequenceKey(agentId: string, sessionKey: string): string {
  return `${agentId}\u0000${sessionKey}`;
}

export type PendingBatch = {
  agentId: string;
  sessionKey: string;
  /** Deterministic episode uuid: the identity the server merges on. */
  uuid: string;
  name: string;
  batchNumber: number;
  /** The episode body, kept so the batch can be submitted again unchanged. */
  episodeBody: string;
  previousEpisodeUuids: string[];
  /**
   * Kept so a resubmission is byte-identical to the original.
   *
   * Regenerating the reference time on retry would move the episode in the
   * conversation's timeline every time the backend was slow, and the predecessor
   * link is what keeps the chain intact — neither may be invented at retry time.
   */
  referenceTime: string;
  sagaPreviousEpisodeUuid?: string;
  submittedAt: number;
  attempts: number;
};

export type PendingConfirmationOptions = {
  /** How long to wait after a submission before expecting the episode to exist. */
  graceMs: number;
  /** The longest a retry may be deferred. Doubling stops here. */
  maxBackoffMs: number;
  /** After this many attempts a batch is worth mentioning — not worth abandoning. */
  attentionAfterAttempts: number;
  /** How many bytes of outstanding batches to keep before the oldest are dropped. */
  maxBytes: number;
};

export const DEFAULT_CONFIRMATION_OPTIONS: PendingConfirmationOptions = {
  // Extraction on a busy backend takes tens of seconds; a grace shorter than that
  // would resubmit work that is merely in progress.
  graceMs: 30_000,
  // The failure this exists for is an unreachable or rate-limited model, which
  // comes back in hours. Retrying every thirty seconds through that keeps a
  // depleted quota pinned and delays the recovery it is waiting for, so the wait
  // doubles — and stops doubling at an hour, because a backend that returns after
  // a week should not then be ignored for a day.
  maxBackoffMs: 3_600_000,
  attentionAfterAttempts: 5,
  // Fifty gigabytes of conversation is a quantity these agents cannot produce in
  // years. The bound exists so that failure is bounded, not to economise: nothing
  // is given up while there is room, however long the backend stays down.
  maxBytes: 50 * 1024 * 1024 * 1024,
};

export type ConfirmationSnapshot = {
  outstanding: number;
  /** Total size of what is outstanding, for reporting against the bound. */
  bytes: number;
  /** Batches whose backoff has elapsed, oldest first: what to resend now. */
  due: PendingBatch[];
  /**
   * Batches that have been retried enough times to be worth mentioning.
   *
   * They keep being retried. This list exists so the status tool can say that
   * something is not landing, not so anything gets abandoned.
   */
  needsAttention: PendingBatch[];
  /** Batches dropped because the byte bound was reached, since the process started. */
  dropped: number;
  oldestAgeMs?: number;
};

export class PendingConfirmationTracker {
  private readonly pending = new Map<string, PendingBatch>();
  private readonly options: PendingConfirmationOptions;
  private droppedCount = 0;

  constructor(options: Partial<PendingConfirmationOptions> = {}) {
    this.options = { ...DEFAULT_CONFIRMATION_OPTIONS, ...options };
  }

  /** Record a batch the backend has accepted but not yet proven it stored. */
  track(batch: Omit<PendingBatch, "submittedAt" | "attempts"> & Partial<Pick<PendingBatch, "submittedAt" | "attempts">>): void {
    if (!batch.uuid.trim()) throw new Error("a pending batch needs its episode uuid");
    const existing = this.pending.get(batch.uuid);
    this.pending.set(batch.uuid, {
      ...batch,
      previousEpisodeUuids: [...batch.previousEpisodeUuids],
      submittedAt: batch.submittedAt ?? Date.now(),
      // A resubmission of the same uuid continues its attempt count rather than
      // starting over: the count is what widens the wait and what tells the
      // status tool that something is not landing.
      attempts: batch.attempts ?? (existing ? existing.attempts + 1 : 0),
    });
    this.enforceBound();
  }

  /** Forget batches whose episodes are now in the graph. */
  confirm(uuids: readonly string[]): number {
    let confirmed = 0;
    for (const uuid of uuids) {
      if (this.pending.delete(uuid)) confirmed += 1;
    }
    return confirmed;
  }

  /** Every outstanding uuid, for asking the server which of them exist. */
  outstandingUuids(): string[] {
    return [...this.pending.keys()];
  }

  /** How long to wait before the next attempt on a batch that has failed this often. */
  backoffFor(attempts: number): number {
    const doubled = this.options.graceMs * 2 ** Math.max(0, attempts);
    return Math.min(doubled, this.options.maxBackoffMs);
  }

  snapshot(now = Date.now()): ConfirmationSnapshot {
    const all = [...this.pending.values()].sort((a, b) => a.submittedAt - b.submittedAt);
    return {
      outstanding: all.length,
      bytes: all.reduce((sum, batch) => sum + batch.episodeBody.length, 0),
      due: all.filter((batch) => now - batch.submittedAt >= this.backoffFor(batch.attempts)),
      needsAttention: all.filter((batch) => batch.attempts >= this.options.attentionAfterAttempts),
      dropped: this.droppedCount,
      ...(all.length > 0 ? { oldestAgeMs: now - (all[0]?.submittedAt ?? now) } : {}),
    };
  }

  export(): PendingBatch[] {
    return [...this.pending.values()].map((batch) => ({ ...batch, previousEpisodeUuids: [...batch.previousEpisodeUuids] }));
  }

  restore(batches: readonly PendingBatch[]): void {
    this.pending.clear();
    for (const batch of batches) {
      if (typeof batch?.uuid === "string" && batch.uuid.trim()) {
        this.pending.set(batch.uuid, { ...batch, previousEpisodeUuids: [...(batch.previousEpisodeUuids ?? [])] });
      }
    }
    this.enforceBound();
  }

  /**
   * The highest batch number this process is known to have issued per session.
   *
   * Restart hydration otherwise trusts the backend's episode count, which lags
   * behind acceptance — and a lagging count hands the same number out twice. That
   * is how one dialog ended up with two different episodes both called `-22`.
   */
  highestIssued(): Map<string, number> {
    const highest = new Map<string, number>();
    for (const batch of this.pending.values()) {
      const key = sequenceKey(batch.agentId, batch.sessionKey);
      highest.set(key, Math.max(highest.get(key) ?? 0, batch.batchNumber));
    }
    return highest;
  }

  private enforceBound(): void {
    while (this.bytes() > this.options.maxBytes && this.pending.size > 0) {
      // Oldest first: the newest batches are the ones still likely to land, and
      // the oldest have had the most chances already.
      const oldest = [...this.pending.values()].sort((a, b) => a.submittedAt - b.submittedAt)[0];
      if (!oldest) break;
      this.pending.delete(oldest.uuid);
      this.droppedCount += 1;
    }
  }

  private bytes(): number {
    let total = 0;
    for (const batch of this.pending.values()) total += batch.episodeBody.length;
    return total;
  }
}
