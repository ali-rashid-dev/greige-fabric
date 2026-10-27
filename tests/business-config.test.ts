import { describe, expect, it } from "vitest";
import { businessConfig } from "../src/config/business";

describe("business setup", () => {
  it("uses the Greige Fabric POS identity and PKR baseline", () => {
    expect(businessConfig).toEqual({
      name: "Greige Fabric",
      productName: "Greige Fabric POS",
      currency: "PKR",
    });
  });
});
