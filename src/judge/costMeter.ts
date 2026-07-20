// CostMeter — enforces `maxModelCostUsd` pre-call under a concurrent worker
// pool (documentation/08-data-models.md invariant 5: cost.modelUsd ≤
// maxModelCostUsd, always). A naive "check remaining budget, then call" races
// across concurrent workers and can collectively overspend the cap.
//
// reserve/commit/refund makes the check-and-deduct atomic: `reserve` runs
// synchronously (no `await` inside it), and JS's single-threaded event loop
// means no other call can interleave between the read of `spent + reserved`
// and the write that grows it. Reservations use a fixed, conservative
// per-call ceiling (not the real cost, which is only known after the call
// returns), so vigil may leave a little budget unspent — it will never spend
// past the cap.

export interface CostTicket {
  readonly id: number;
  readonly reservedUsd: number;
}

export class CostMeter {
  private readonly capUsd: number;
  private spentUsd = 0;
  private reservedUsd = 0;
  private nextId = 1;
  private committed = 0;

  constructor(capUsd: number) {
    this.capUsd = capUsd;
  }

  /** Total actually spent so far (committed calls only). */
  get spent(): number {
    return this.spentUsd;
  }

  /** Number of committed calls — RunResult.cost.modelCalls. */
  get calls(): number {
    return this.committed;
  }

  /** Reserve `estUsd` against the cap. Returns null if the cap would be exceeded. */
  reserve(estUsd: number): CostTicket | null {
    if (this.spentUsd + this.reservedUsd + estUsd > this.capUsd) return null;
    this.reservedUsd += estUsd;
    return { id: this.nextId++, reservedUsd: estUsd };
  }

  /** Convert a reservation into real spend once the call's actual cost is known. */
  commit(ticket: CostTicket, actualUsd: number): void {
    this.reservedUsd = Math.max(0, this.reservedUsd - ticket.reservedUsd);
    this.spentUsd += actualUsd;
    this.committed++;
  }

  /** Release a reservation without spending — used when a call is skipped or degrades before charging. */
  refund(ticket: CostTicket): void {
    this.reservedUsd = Math.max(0, this.reservedUsd - ticket.reservedUsd);
  }
}
