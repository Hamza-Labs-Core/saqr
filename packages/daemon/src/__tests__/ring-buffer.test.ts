/**
 * Tests for the RingBuffer — fixed-size circular buffer for terminal output.
 *
 * Covers: ring buffer write/read, overflow wrapping, clear, size tracking.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { RingBuffer } from "../sessions/ring-buffer.js";

describe("RingBuffer", () => {
  describe("construction", () => {
    it("should create a buffer with the specified capacity", () => {
      const buf = new RingBuffer(1024);
      expect(buf.capacity).toBe(1024);
      expect(buf.size).toBe(0);
    });

    it("should default to 8MB capacity when not specified", () => {
      const buf = new RingBuffer();
      expect(buf.capacity).toBe(8 * 1024 * 1024);
    });

    it("should throw for non-positive capacity", () => {
      expect(() => new RingBuffer(0)).toThrow();
      expect(() => new RingBuffer(-1)).toThrow();
    });
  });

  describe("write and getContents", () => {
    let buf: RingBuffer;

    beforeEach(() => {
      buf = new RingBuffer(64);
    });

    it("should write data and read it back", () => {
      buf.write("hello");
      expect(buf.getContents()).toBe("hello");
    });

    it("should accumulate multiple writes", () => {
      buf.write("hello ");
      buf.write("world");
      expect(buf.getContents()).toBe("hello world");
    });

    it("should track size correctly after writes", () => {
      buf.write("abc");
      expect(buf.size).toBe(3);
      buf.write("de");
      expect(buf.size).toBe(5);
    });

    it("should return empty string when nothing written", () => {
      expect(buf.getContents()).toBe("");
    });

    it("should handle writing empty strings", () => {
      buf.write("");
      expect(buf.size).toBe(0);
      expect(buf.getContents()).toBe("");
    });

    it("should handle writing Buffer data", () => {
      buf.write(Buffer.from("hello"));
      expect(buf.getContents()).toBe("hello");
    });
  });

  describe("overflow and wrapping", () => {
    it("should wrap around when capacity is exceeded", () => {
      const buf = new RingBuffer(10);
      buf.write("1234567890"); // exactly fills buffer
      expect(buf.getContents()).toBe("1234567890");
      expect(buf.size).toBe(10);

      buf.write("AB"); // overwrites the oldest 2 bytes
      const contents = buf.getContents();
      expect(contents).toBe("34567890AB");
      expect(buf.size).toBe(10);
    });

    it("should handle write larger than capacity", () => {
      const buf = new RingBuffer(5);
      buf.write("1234567890"); // 10 bytes into 5-byte buffer
      // Only the last 5 bytes should remain
      expect(buf.getContents()).toBe("67890");
      expect(buf.size).toBe(5);
    });

    it("should handle multiple overflow wraps", () => {
      const buf = new RingBuffer(8);
      buf.write("AAAA"); // [A,A,A,A,_,_,_,_]
      buf.write("BBBB"); // [A,A,A,A,B,B,B,B]
      buf.write("CC");   // Overwrites first 2 A's: [C,C,A,A,B,B,B,B] -> reading from write head
      const contents = buf.getContents();
      expect(contents).toBe("AABBBBCC");
      expect(buf.size).toBe(8);
    });

    it("should never exceed capacity", () => {
      const buf = new RingBuffer(16);
      for (let i = 0; i < 100; i++) {
        buf.write("data");
      }
      expect(buf.size).toBeLessThanOrEqual(16);
    });
  });

  describe("clear", () => {
    it("should clear all contents", () => {
      const buf = new RingBuffer(64);
      buf.write("some data here");
      buf.clear();
      expect(buf.size).toBe(0);
      expect(buf.getContents()).toBe("");
    });

    it("should allow writing after clear", () => {
      const buf = new RingBuffer(64);
      buf.write("first");
      buf.clear();
      buf.write("second");
      expect(buf.getContents()).toBe("second");
    });
  });

  describe("getContents with offset", () => {
    it("should return contents from the given byte offset", () => {
      const buf = new RingBuffer(64);
      buf.write("hello world");
      expect(buf.getContents(6)).toBe("world");
    });

    it("should return empty string if offset equals size", () => {
      const buf = new RingBuffer(64);
      buf.write("hello");
      expect(buf.getContents(5)).toBe("");
    });

    it("should return all contents for offset 0", () => {
      const buf = new RingBuffer(64);
      buf.write("hello");
      expect(buf.getContents(0)).toBe("hello");
    });
  });

  describe("totalWritten", () => {
    it("should track total bytes written including overwritten data", () => {
      const buf = new RingBuffer(8);
      buf.write("12345678"); // 8 bytes
      expect(buf.totalWritten).toBe(8);
      buf.write("AB"); // 2 more
      expect(buf.totalWritten).toBe(10);
    });
  });
});
