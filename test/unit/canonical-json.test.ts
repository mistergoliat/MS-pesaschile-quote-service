import { describe, expect, it } from "vitest";

import {
  createCanonicalRequestHash,
  toCanonicalJson
} from "../../src/application/quote/canonical-json";

describe("canonical JSON hashing", () => {
  it("sorts object keys recursively while preserving array order", () => {
    const left = {
      b: 2,
      a: {
        d: 4,
        c: [3, { z: 2, y: 1 }]
      }
    };
    const right = {
      a: {
        c: [3, { y: 1, z: 2 }],
        d: 4
      },
      b: 2
    };

    expect(toCanonicalJson(left)).toBe(toCanonicalJson(right));
    expect(createCanonicalRequestHash(left)).toBe(createCanonicalRequestHash(right));
  });

  it("keeps arrays order-sensitive for hashing", () => {
    expect(
      createCanonicalRequestHash({
        items: [1, 2, 3]
      })
    ).not.toBe(
      createCanonicalRequestHash({
        items: [3, 2, 1]
      })
    );
  });
});

