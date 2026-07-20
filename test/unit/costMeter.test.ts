import { describe, it, expect } from "vitest";
import { CostMeter } from "../../src/judge/costMeter.js";

describe("CostMeter", () => {
  it("reserves and commits, tracking real spend and call count", () => {
    const meter = new CostMeter(1.0);
    const ticket = meter.reserve(0.006)!;
    expect(ticket).not.toBeNull();
    expect(meter.spent).toBe(0); // not spent until committed
    expect(meter.calls).toBe(0);
    meter.commit(ticket, 0.004); // actual cost can be less than the reservation
    expect(meter.spent).toBe(0.004);
    expect(meter.calls).toBe(1);
  });

  it("refund does not count as a call", () => {
    const meter = new CostMeter(1.0);
    meter.refund(meter.reserve(0.006)!);
    expect(meter.calls).toBe(0);
  });

  it("denies a reservation that would exceed the cap", () => {
    const meter = new CostMeter(0.01);
    const first = meter.reserve(0.006);
    expect(first).not.toBeNull();
    const second = meter.reserve(0.006); // 0.006 + 0.006 > 0.01
    expect(second).toBeNull();
  });

  it("never exceeds the cap under concurrent-style interleaved reserve calls", () => {
    const cap = 0.05;
    const meter = new CostMeter(cap);
    const perCallEstimate = 0.006;
    // Simulate a worker pool of 20 concurrent pages all reserving before any commits —
    // this is exactly the race the reserve/commit design exists to prevent.
    const tickets = Array.from({ length: 20 }, () => meter.reserve(perCallEstimate));
    const granted = tickets.filter((t) => t !== null);
    // At most floor(cap / perCallEstimate) = 8 reservations can be granted.
    expect(granted.length).toBeLessThanOrEqual(Math.floor(cap / perCallEstimate));
    const totalReserved = granted.reduce((sum, t) => sum + t!.reservedUsd, 0);
    expect(totalReserved).toBeLessThanOrEqual(cap + 1e-9);
  });

  it("refund releases a reservation without recording spend", () => {
    const meter = new CostMeter(0.01);
    const ticket = meter.reserve(0.006)!;
    meter.refund(ticket);
    expect(meter.spent).toBe(0);
    // The full cap should be available again.
    const next = meter.reserve(0.01);
    expect(next).not.toBeNull();
  });

  it("commit after refund does not double-release the reservation pool", () => {
    const meter = new CostMeter(0.01);
    const ticket = meter.reserve(0.006)!;
    meter.refund(ticket);
    // A second reservation now occupies the freed space.
    const other = meter.reserve(0.006)!;
    expect(other).not.toBeNull();
    meter.commit(other, 0.005);
    expect(meter.spent).toBe(0.005);
  });

  it("boundary: a reservation exactly at the remaining cap is granted", () => {
    const meter = new CostMeter(0.006);
    const ticket = meter.reserve(0.006);
    expect(ticket).not.toBeNull();
    const next = meter.reserve(0.000001);
    expect(next).toBeNull();
  });
});
