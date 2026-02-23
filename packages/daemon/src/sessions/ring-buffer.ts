/**
 * RingBuffer — fixed-size circular buffer for terminal output.
 *
 * Stores PTY output for reconnection replay. When the buffer is full,
 * the oldest data is overwritten by new data. Default capacity is 8MB.
 *
 * Thread-safe within a single Node.js event loop turn (no concurrent writes).
 */

const DEFAULT_CAPACITY = 8 * 1024 * 1024; // 8MB

/**
 * A fixed-size ring buffer that stores string data efficiently.
 *
 * Data is stored as UTF-8 encoded bytes in a circular buffer.
 * When the buffer wraps around, the oldest data is discarded.
 */
export class RingBuffer {
  /** Internal byte storage */
  private readonly buffer: Buffer;

  /** Write position in the buffer */
  private writePos = 0;

  /** Whether the buffer has wrapped at least once */
  private wrapped = false;

  /** Total number of bytes written (including overwritten) */
  private _totalWritten = 0;

  /** Maximum capacity in bytes */
  readonly capacity: number;

  /**
   * Creates a new RingBuffer.
   *
   * @param capacity - Maximum size in bytes. Defaults to 8MB.
   * @throws If capacity is not a positive number.
   */
  constructor(capacity: number = DEFAULT_CAPACITY) {
    if (capacity <= 0) {
      throw new Error(`RingBuffer capacity must be positive, got ${capacity}`);
    }
    this.capacity = capacity;
    this.buffer = Buffer.alloc(capacity);
  }

  /**
   * Write data to the ring buffer.
   *
   * If the data exceeds remaining space, older data is overwritten.
   * If the data is larger than capacity, only the last `capacity` bytes
   * are kept.
   *
   * @param data - String or Buffer to write.
   */
  write(data: string | Buffer): void {
    const bytes =
      typeof data === "string" ? Buffer.from(data, "utf-8") : data;

    if (bytes.length === 0) return;

    this._totalWritten += bytes.length;

    // If data is larger than capacity, only keep the tail
    if (bytes.length >= this.capacity) {
      const start = bytes.length - this.capacity;
      bytes.copy(this.buffer, 0, start, bytes.length);
      this.writePos = 0;
      this.wrapped = true;
      return;
    }

    const spaceToEnd = this.capacity - this.writePos;

    if (bytes.length <= spaceToEnd) {
      // Fits without wrapping
      bytes.copy(this.buffer, this.writePos);
      this.writePos += bytes.length;
      if (this.writePos === this.capacity) {
        this.writePos = 0;
        this.wrapped = true;
      }
    } else {
      // Needs to wrap
      bytes.copy(this.buffer, this.writePos, 0, spaceToEnd);
      const remaining = bytes.length - spaceToEnd;
      bytes.copy(this.buffer, 0, spaceToEnd, bytes.length);
      this.writePos = remaining;
      this.wrapped = true;
    }
  }

  /**
   * Get the contents of the buffer as a string.
   *
   * @param byteOffset - If provided, skip this many bytes from the start
   *                      of the logical content. Defaults to 0 (all content).
   * @returns The buffer contents as a UTF-8 string.
   */
  getContents(byteOffset: number = 0): string {
    const currentSize = this.size;
    if (currentSize === 0 || byteOffset >= currentSize) {
      return "";
    }

    if (!this.wrapped) {
      // No wrapping: data is from 0..writePos
      return this.buffer.toString("utf-8", byteOffset, this.writePos);
    }

    // Buffer has wrapped: logical start is at writePos (oldest data)
    // logical content = [writePos..capacity) + [0..writePos)
    const startOffset = byteOffset;
    const logicalStart = this.writePos;

    // Build the result from the two segments
    const part1Start = logicalStart;
    const part1Len = this.capacity - logicalStart;
    const part2Len = this.writePos;

    if (startOffset < part1Len) {
      // Offset falls in part 1
      const p1 = this.buffer.toString(
        "utf-8",
        part1Start + startOffset,
        this.capacity,
      );
      const p2 = this.buffer.toString("utf-8", 0, part2Len);
      return p1 + p2;
    } else {
      // Offset falls in part 2
      const p2Offset = startOffset - part1Len;
      return this.buffer.toString("utf-8", p2Offset, part2Len);
    }
  }

  /**
   * Clear all data from the buffer.
   */
  clear(): void {
    this.writePos = 0;
    this.wrapped = false;
    // No need to zero the buffer — writePos/wrapped control valid data
  }

  /**
   * Current number of bytes of valid data in the buffer.
   */
  get size(): number {
    if (this.wrapped) {
      return this.capacity;
    }
    return this.writePos;
  }

  /**
   * Total number of bytes written to the buffer (including overwritten data).
   */
  get totalWritten(): number {
    return this._totalWritten;
  }
}
