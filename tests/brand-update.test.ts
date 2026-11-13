import { describe, expect, it } from "vitest";
import { updateBrandSchema } from "@/lib/schemas/brand";

describe("partial brand updates", () => {
  it("don't inject create-time defaults (would wipe guidelines/slots)", () => {
    expect(updateBrandSchema.parse({ name: "x" })).toEqual({ name: "x" });
  });
});
