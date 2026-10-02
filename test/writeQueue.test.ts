import { describe, expect, it } from "vitest";
import { withWriteQueue } from "@/lib/writeQueue";

/**
 * Unit coverage for src/lib/writeQueue.ts's FIFO mutex in isolation, with
 * no database involved — the ordering/exclusion/rejection-isolation
 * guarantees it must hold regardless of what `fn` does.
 */

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("withWriteQueue", () => {
  it("runs queued operations in the exact order they were called (FIFO), even when later ones would resolve faster", async () => {
    const order: number[] = [];
    const calls = [30, 5, 20, 1, 15].map((delayMs, i) =>
      withWriteQueue(async () => {
        await sleep(delayMs);
        order.push(i);
      }),
    );
    await Promise.all(calls);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it("never runs two queued operations concurrently — each fully settles before the next starts", async () => {
    let active = 0;
    let maxActive = 0;
    const calls = Array.from({ length: 10 }, () =>
      withWriteQueue(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(5);
        active -= 1;
      }),
    );
    await Promise.all(calls);
    expect(maxActive).toBe(1);
  });

  it("propagates a rejected operation's error only to its own caller", async () => {
    const boom = new Error("boom");
    await expect(withWriteQueue(async () => Promise.reject(boom))).rejects.toBe(boom);
  });

  it("a rejected operation does not poison the queue — operations queued after it still run, in order", async () => {
    const order: string[] = [];

    const first = withWriteQueue(async () => {
      order.push("first");
    });
    const failing = withWriteQueue(async () => {
      order.push("failing");
      throw new Error("simulated failure");
    });
    const after = withWriteQueue(async () => {
      order.push("after");
      return "after-result";
    });

    await expect(first).resolves.toBeUndefined();
    await expect(failing).rejects.toThrow("simulated failure");
    await expect(after).resolves.toBe("after-result");
    expect(order).toEqual(["first", "failing", "after"]);
  });

  it("a rejected operation does not poison the queue even when queued BEFORE a later success (ordering + isolation together)", async () => {
    const results: Array<{ index: number; outcome: "ok" | "err" }> = [];
    const calls = [0, 1, 2, 3, 4].map((i) =>
      withWriteQueue(async () => {
        await sleep(1);
        if (i === 2) throw new Error(`fail-${i}`);
        return i;
      })
        .then((v) => {
          results.push({ index: v as number, outcome: "ok" });
        })
        .catch(() => {
          results.push({ index: i, outcome: "err" });
        }),
    );
    await Promise.all(calls);
    expect(results.map((r) => r.index)).toEqual([0, 1, 2, 3, 4]);
    expect(results.find((r) => r.index === 2)?.outcome).toBe("err");
    expect(results.filter((r) => r.outcome === "ok")).toHaveLength(4);
  });

  it("supports many back-to-back failures in a row without ever hanging", async () => {
    const calls = Array.from({ length: 20 }, (_, i) =>
      withWriteQueue(async () => {
        throw new Error(`fail-${i}`);
      }).catch((err: Error) => err.message),
    );
    const outcomes = await Promise.all(calls);
    expect(outcomes).toEqual(Array.from({ length: 20 }, (_, i) => `fail-${i}`));
  });

  it("runs a representative sequential chain shaped like provenance/claims persistence (read, in-memory work, write) without hanging", async () => {
    const log: string[] = [];

    async function simulatedPersist(id: number) {
      return withWriteQueue(async () => {
        log.push(`start-${id}`);
        await sleep(1); // stand-in for the findMany read
        await sleep(1); // stand-in for the createMany write
        log.push(`end-${id}`);
        return id;
      });
    }

    const outcomes = await Promise.all([1, 2, 3].map((id) => simulatedPersist(id)));
    expect(outcomes).toEqual([1, 2, 3]);
    // Each operation's start/end pair is contiguous — never interleaved
    // with another operation's start/end, proving mutual exclusion held
    // across the simulated read+write shape, not just a trivial callback.
    expect(log).toEqual(["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);
  });

  it("returns the operation's own resolved value to its caller", async () => {
    const value = await withWriteQueue(async () => ({ id: "abc", count: 42 }));
    expect(value).toEqual({ id: "abc", count: 42 });
  });
});
