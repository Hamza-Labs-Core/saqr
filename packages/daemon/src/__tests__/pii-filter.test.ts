/**
 * Tests for Client-Side PII Filter — Pre-sync protection.
 *
 * Covers:
 * - Email address detection
 * - IP address detection
 * - User path detection (Unix, macOS, Windows)
 * - API key detection
 * - Metadata scanning (flat and nested)
 * - Auto-redaction mode
 * - Reject mode
 * - Exempt fields
 * - Standalone convenience functions
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  PIIFilter,
  scanForPII,
  redactPII,
  type PIIDetection,
  type PIIAction,
} from "../security/pii-filter.js";

describe("PIIFilter", () => {
  let filter: PIIFilter;

  beforeEach(() => {
    filter = new PIIFilter();
  });

  // -----------------------------------------------------------------------
  // Email Detection
  // -----------------------------------------------------------------------

  describe("email detection", () => {
    it("should detect simple email addresses", () => {
      const detections = filter.scanValue("user@example.com");
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe("email_address");
    });

    it("should detect email with subdomains", () => {
      const detections = filter.scanValue("user@mail.company.co.uk");
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe("email_address");
    });

    it("should detect email with plus tag", () => {
      const detections = filter.scanValue("john.doe+tag@company.com");
      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe("email_address");
    });

    it("should detect email embedded in text", () => {
      const detections = filter.scanValue("Contact us at admin@test.org for help");
      expect(detections).toHaveLength(1);
    });

    it("should not false-positive on version strings", () => {
      const detections = filter.scanValue("v1.2.3");
      const emailDetections = detections.filter((d) => d.type === "email_address");
      expect(emailDetections).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // IP Address Detection
  // -----------------------------------------------------------------------

  describe("IP address detection", () => {
    it("should detect IPv4 addresses", () => {
      const detections = filter.scanValue("Server at 192.168.1.100");
      const ipDetections = detections.filter((d) => d.type === "ip_address");
      expect(ipDetections).toHaveLength(1);
    });

    it("should detect localhost IP", () => {
      const detections = filter.scanValue("127.0.0.1");
      const ipDetections = detections.filter((d) => d.type === "ip_address");
      expect(ipDetections).toHaveLength(1);
    });

    it("should detect public IP addresses", () => {
      const detections = filter.scanValue("External IP: 203.0.113.42");
      const ipDetections = detections.filter((d) => d.type === "ip_address");
      expect(ipDetections).toHaveLength(1);
    });

    it("should detect multiple IPs in same string", () => {
      const detections = filter.scanValue("From 10.0.0.1 to 10.0.0.2");
      const ipDetections = detections.filter((d) => d.type === "ip_address");
      expect(ipDetections).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // User Path Detection
  // -----------------------------------------------------------------------

  describe("user path detection", () => {
    it("should detect Unix home paths", () => {
      const detections = filter.scanValue("/home/johndoe/projects/app");
      expect(detections.some((d) => d.type === "user_path")).toBe(true);
    });

    it("should detect macOS user paths", () => {
      const detections = filter.scanValue("/Users/jsmith/Documents/code");
      expect(detections.some((d) => d.type === "user_path")).toBe(true);
    });

    it("should detect Windows user paths", () => {
      const detections = filter.scanValue("C:\\Users\\JohnDoe\\Desktop");
      expect(detections.some((d) => d.type === "user_path")).toBe(true);
    });

    it("should not false-positive on safe paths", () => {
      const detections = filter.scanValue("/var/log/app.log");
      expect(detections.filter((d) => d.type === "user_path")).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // API Key Detection
  // -----------------------------------------------------------------------

  describe("API key detection", () => {
    it("should detect OpenAI-style API keys", () => {
      const detections = filter.scanValue("sk-abcdefghijklmnopqrstuvwx");
      expect(detections.some((d) => d.type === "api_key")).toBe(true);
    });

    it("should detect GitHub personal access tokens", () => {
      const detections = filter.scanValue(
        "ghp_abcdefghijklmnopqrstuvwxyz1234567890"
      );
      expect(detections.some((d) => d.type === "api_key")).toBe(true);
    });

    it("should detect AWS access key IDs", () => {
      const detections = filter.scanValue("AKIAIOSFODNN7EXAMPLE");
      expect(detections.some((d) => d.type === "api_key")).toBe(true);
    });

    it("should not false-positive on short strings", () => {
      const detections = filter.scanValue("sk-short");
      expect(detections.filter((d) => d.type === "api_key")).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Metadata Scanning
  // -----------------------------------------------------------------------

  describe("scanMetadata", () => {
    it("should scan flat metadata for PII", () => {
      const detections = filter.scanMetadata({
        project_id: "proj-abc",
        agent_email: "user@example.com",
        notes: "Normal text",
      });

      expect(detections).toHaveLength(1);
      expect(detections[0].field).toBe("agent_email");
      expect(detections[0].type).toBe("email_address");
    });

    it("should scan nested objects", () => {
      const detections = filter.scanMetadata({
        project_id: "proj-abc",
        config: {
          server: "192.168.1.1",
          name: "test",
        },
      });

      expect(detections).toHaveLength(1);
      expect(detections[0].field).toBe("config.server");
      expect(detections[0].type).toBe("ip_address");
    });

    it("should scan arrays", () => {
      const detections = filter.scanMetadata({
        paths: ["/home/user1/code", "/home/user2/code"],
      });

      expect(detections).toHaveLength(2);
      expect(detections[0].field).toBe("paths[0]");
      expect(detections[1].field).toBe("paths[1]");
    });

    it("should skip exempt fields", () => {
      const detections = filter.scanMetadata({
        encrypted_blob: "user@example.com",
        data: { email: "user@example.com" },
      });

      expect(detections).toHaveLength(0);
    });

    it("should return empty for clean metadata", () => {
      const detections = filter.scanMetadata({
        project_id: "proj-abc123",
        session_id: "sess-001",
        event_type: "ToolCallCompleted",
        sequence: 1,
      });

      expect(detections).toHaveLength(0);
    });

    it("should detect multiple types in one object", () => {
      const detections = filter.scanMetadata({
        email: "user@example.com",
        server: "192.168.1.1",
        path: "/home/johndoe/app",
      });

      const types = new Set(detections.map((d) => d.type));
      expect(types.has("email_address")).toBe(true);
      expect(types.has("ip_address")).toBe(true);
      expect(types.has("user_path")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // filterMetadata — Redact Mode
  // -----------------------------------------------------------------------

  describe("filterMetadata - redact mode", () => {
    it("should redact PII from string values", () => {
      const redactFilter = new PIIFilter({ action: "redact" });
      const { clean, detections, rejected } = redactFilter.filterMetadata({
        project_id: "proj-abc",
        email: "user@example.com",
      });

      expect(rejected).toBe(false);
      expect(detections).toHaveLength(1);
      expect(clean.email).toBe("[REDACTED]");
      expect(clean.project_id).toBe("proj-abc");
    });

    it("should redact PII in nested objects", () => {
      const redactFilter = new PIIFilter({ action: "redact" });
      const { clean } = redactFilter.filterMetadata({
        config: {
          ip: "10.0.0.1",
          name: "safe",
        },
      });

      const config = clean.config as Record<string, unknown>;
      expect(config.ip).toBe("[REDACTED]");
      expect(config.name).toBe("safe");
    });

    it("should redact PII in arrays", () => {
      const redactFilter = new PIIFilter({ action: "redact" });
      const { clean } = redactFilter.filterMetadata({
        emails: ["admin@test.com", "safe-string"],
      });

      const emails = clean.emails as string[];
      expect(emails[0]).toBe("[REDACTED]");
      expect(emails[1]).toBe("safe-string");
    });

    it("should not modify clean metadata", () => {
      const redactFilter = new PIIFilter({ action: "redact" });
      const input = {
        project_id: "proj-abc",
        event_type: "ToolCallCompleted",
      };
      const { clean, detections } = redactFilter.filterMetadata(input);

      expect(clean).toEqual(input);
      expect(detections).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // filterMetadata — Reject Mode
  // -----------------------------------------------------------------------

  describe("filterMetadata - reject mode", () => {
    it("should reject metadata with PII", () => {
      const rejectFilter = new PIIFilter({ action: "reject" });
      const { rejected, detections } = rejectFilter.filterMetadata({
        email: "user@example.com",
      });

      expect(rejected).toBe(true);
      expect(detections).toHaveLength(1);
    });

    it("should not reject clean metadata", () => {
      const rejectFilter = new PIIFilter({ action: "reject" });
      const { rejected } = rejectFilter.filterMetadata({
        project_id: "proj-abc",
        event_type: "ToolCallCompleted",
      });

      expect(rejected).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Custom Exempt Fields
  // -----------------------------------------------------------------------

  describe("custom exempt fields", () => {
    it("should respect custom exempt fields", () => {
      const customFilter = new PIIFilter({
        exemptFields: new Set(["allowed_email_field"]),
      });

      const detections = customFilter.scanMetadata({
        allowed_email_field: "user@example.com",
        other_field: "user@example.com",
      });

      expect(detections).toHaveLength(1);
      expect(detections[0].field).toBe("other_field");
    });
  });

  // -----------------------------------------------------------------------
  // Standalone Functions
  // -----------------------------------------------------------------------

  describe("scanForPII (standalone)", () => {
    it("should detect PII in metadata", () => {
      const detections = scanForPII({
        email: "admin@company.com",
        project_id: "proj-abc",
      });

      expect(detections).toHaveLength(1);
      expect(detections[0].type).toBe("email_address");
    });
  });

  describe("redactPII (standalone)", () => {
    it("should redact PII from metadata", () => {
      const clean = redactPII({
        email: "admin@company.com",
        name: "Safe Name",
      });

      expect(clean.email).toBe("[REDACTED]");
      expect(clean.name).toBe("Safe Name");
    });

    it("should handle nested PII redaction", () => {
      const clean = redactPII({
        config: {
          ip: "192.168.0.1",
          port: 8080,
        },
      });

      const config = clean.config as Record<string, unknown>;
      expect(config.ip).toBe("[REDACTED]");
      expect(config.port).toBe(8080);
    });
  });

  // -----------------------------------------------------------------------
  // Edge Cases
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    it("should handle empty metadata", () => {
      const detections = filter.scanMetadata({});
      expect(detections).toHaveLength(0);
    });

    it("should handle null values gracefully", () => {
      const detections = filter.scanMetadata({
        field: null as unknown as string,
      });
      expect(detections).toHaveLength(0);
    });

    it("should handle numeric values", () => {
      const detections = filter.scanMetadata({
        count: 42,
        rate: 3.14,
      });
      expect(detections).toHaveLength(0);
    });

    it("should handle boolean values", () => {
      const detections = filter.scanMetadata({
        active: true,
        deleted: false,
      });
      expect(detections).toHaveLength(0);
    });

    it("should redact partial PII in longer strings", () => {
      const clean = redactPII({
        log: "User john@test.com logged in from 10.0.0.5",
      });

      expect(clean.log).not.toContain("john@test.com");
      expect(clean.log).not.toContain("10.0.0.5");
      expect(clean.log).toContain("[REDACTED]");
    });
  });
});
