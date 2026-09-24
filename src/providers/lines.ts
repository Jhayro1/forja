/**
 * Splits a byte stream into JSON lines, tolerating chunks cut at any point.
 * A line longer than `maxLineBytes` is a protocol error, not an allocation.
 */
export class JsonLineSplitter {
  private buffer = '';

  constructor(private readonly maxLineBytes = 8 * 1024 * 1024) {}

  push(chunk: string): Array<{ value: unknown } | { invalid: string }> {
    this.buffer += chunk;
    const out: Array<{ value: unknown } | { invalid: string }> = [];
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) out.push(parse(line));
    }
    if (Buffer.byteLength(this.buffer) > this.maxLineBytes) {
      this.buffer = '';
      throw new Error(`línea de salida mayor a ${this.maxLineBytes} bytes`);
    }
    return out;
  }

  /** Remaining bytes without a newline: a final line cut by a crash is reported, not guessed. */
  end(): Array<{ value: unknown } | { invalid: string }> {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest ? [parse(rest)] : [];
  }
}

function parse(line: string): { value: unknown } | { invalid: string } {
  try {
    return { value: JSON.parse(line) as unknown };
  } catch {
    return { invalid: line.slice(0, 200) };
  }
}
