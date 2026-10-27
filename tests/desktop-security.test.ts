import { describe, expect, it } from "vitest";
import { isTrustedSender } from "../src/main/ipc/security";

describe("IPC sender policy", () => {
  const developmentUrl = "http://127.0.0.1:3000";
  const productionUrl = "file:///opt/greige-fabric/out/index.html";

  it("allows only the configured development origin or exact production document", () => {
    expect(isTrustedSender(`${developmentUrl}/`, true, developmentUrl, productionUrl)).toBe(true);
    expect(isTrustedSender("http://localhost:3000/", true, developmentUrl, productionUrl)).toBe(false);
    expect(isTrustedSender("http://127.0.0.1:3001/", true, developmentUrl, productionUrl)).toBe(false);
    expect(isTrustedSender(productionUrl, true, undefined, productionUrl)).toBe(true);
    expect(isTrustedSender("file:///opt/greige-fabric/out/other.html", true, undefined, productionUrl)).toBe(false);
    expect(isTrustedSender(`${developmentUrl}/`, false, developmentUrl, productionUrl)).toBe(false);
  });
});
