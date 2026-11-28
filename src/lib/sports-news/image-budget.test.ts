import { describe, expect, it } from "vitest";
import { createImageBudget } from "./image-budget";

describe("image budget", () => {
  it("caps combined candidates and honours the time budget", () => {
    const b = createImageBudget(5, 1000);
    expect([1, 2, 3, 4, 5, 6].map(() => b.take())).toEqual([true, true, true, true, true, false]);
    expect(b.exhausted).toBe(true);
    let t = 0;
    const timed = createImageBudget(5, 100, () => t);
    expect(timed.take()).toBe(true);
    t = 100;
    expect(timed.take()).toBe(false);
  });
});
