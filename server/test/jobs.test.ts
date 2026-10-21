import { describe, expect, it } from "vitest";
import { mapLimit, within } from "../src/jobs.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("within", () => {
  it("returns the value when the work finishes inside the budget, and leaves slow work running", async () => {
    expect(await within(sleep(5).then(() => "fast"), 100)).toEqual({ done: true, value: "fast" });
    let finished = false;
    const slow = sleep(60).then(() => (finished = true));
    expect(await within(slow, 10)).toEqual({ done: false });
    expect(finished).toBe(false);
    await slow;
    expect(finished).toBe(true);
  });
  it("passes a rejection through when it lands inside the budget", async () => {
    await expect(within(Promise.reject(new Error("boom")), 50)).rejects.toThrow("boom");
  });
});

describe("mapLimit", () => {
  it("never runs more than the cap at once, and still runs everything", async () => {
    let live = 0;
    let peak = 0;
    const done: number[] = [];
    await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
      live++;
      peak = Math.max(peak, live);
      await sleep(5);
      live--;
      done.push(n);
    });
    expect(peak).toBe(3);
    expect(done.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
  it("keeps results in input order and stops starting new work after a failure", async () => {
    expect(await mapLimit([3, 1, 2], 2, async (n) => { await sleep(n); return n * 10; })).toEqual([30, 10, 20]);
    const started: number[] = [];
    await expect(mapLimit([1, 2, 3, 4, 5, 6], 1, async (n) => { started.push(n); if (n === 2) throw new Error("x"); })).rejects.toThrow("x");
    expect(started).toEqual([1, 2]);
  });
});
