import { describe, it, expect } from "vitest";
import {
  sanitizeHeaders,
  compareProtocol,
  formatCalibrationMarkdown,
  BASELINE_PROTOCOL,
} from "./calibrate.js";

describe("Browser Calibration Subsystem", () => {
  it("sanitizes sensitive authorization and cookie headers", () => {
    const rawHeaders = {
      Authorization: "Bearer eyJhbGciOi...",
      Cookie: "MUID=12345; MSPAuth=abcdef",
      "X-MS-Token": "secret-token-here",
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-MS-Client-Request-Id": "req-12345",
    };

    const sanitized = sanitizeHeaders(rawHeaders);
    expect(sanitized["authorization"]).toBe("[REDACTED_SECRET]");
    expect(sanitized["cookie"]).toBe("[REDACTED_SECRET]");
    expect(sanitized["x-ms-token"]).toBe("[REDACTED_SECRET]");
    expect(sanitized["content-type"]).toBe("application/json");
    expect(sanitized["accept"]).toBe("application/json");
    expect(sanitized["x-ms-client-request-id"]).toBe("req-12345");
  });

  it("detects exact match with baseline protocol as compatible", () => {
    const report = compareProtocol({
      headers: {
        authorization: "Bearer test",
        accept: "application/json",
        "content-type": "application/json",
        "x-ms-client-request-id": "cid-123",
      },
      optionsSets: [...BASELINE_PROTOCOL.optionsSets],
      allowedMessageTypes: [...BASELINE_PROTOCOL.allowedMessageTypes],
    });

    expect(report.isCompatible).toBe(true);
    expect(report.breakingCount).toBe(0);
    expect(report.warningCount).toBe(0);
    expect(report.recommendations[0]).toContain("fully compatible");
  });

  it("detects added optionsSets and new flight slices", () => {
    const report = compareProtocol({
      headers: {
        authorization: "Bearer test",
        accept: "application/json",
        "content-type": "application/json",
        "x-ms-client-request-id": "cid-123",
      },
      optionsSets: [...BASELINE_PROTOCOL.optionsSets, "new_future_reasoning_mode"],
      allowedMessageTypes: [...BASELINE_PROTOCOL.allowedMessageTypes],
      sliceIds: ["flight_exp_999"],
    });

    expect(report.isCompatible).toBe(true);
    const addedOpt = report.diffs.find((d) => d.item === "new_future_reasoning_mode");
    expect(addedOpt).toBeDefined();
    expect(addedOpt?.status).toBe("added");
    expect(addedOpt?.severity).toBe("info");

    const slice = report.diffs.find((d) => d.item === "flight_exp_999");
    expect(slice).toBeDefined();
    expect(slice?.category).toBe("sliceIds");
  });

  it("detects missing required headers as breaking changes", () => {
    const report = compareProtocol({
      headers: {
        // Missing authorization, accept, etc.
        "x-ms-client-request-id": "cid-123",
      },
      optionsSets: [...BASELINE_PROTOCOL.optionsSets],
      allowedMessageTypes: [...BASELINE_PROTOCOL.allowedMessageTypes],
    });

    expect(report.isCompatible).toBe(false);
    expect(report.breakingCount).toBeGreaterThan(0);
    const authMissing = report.diffs.find((d) => d.item === "authorization");
    expect(authMissing?.severity).toBe("breaking");
  });

  it("formats markdown calibration report", () => {
    const report = compareProtocol({
      headers: {
        authorization: "Bearer test",
        accept: "application/json",
        "content-type": "application/json",
        "x-ms-client-request-id": "cid-123",
      },
      optionsSets: [...BASELINE_PROTOCOL.optionsSets],
      allowedMessageTypes: [...BASELINE_PROTOCOL.allowedMessageTypes],
    });

    const md = formatCalibrationMarkdown(report);
    expect(md).toContain("# M365 Copilot Protocol Calibration Report");
    expect(md).toContain("**Compatible:** YES");
  });
});
