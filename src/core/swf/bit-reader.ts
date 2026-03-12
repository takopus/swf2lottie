export class BitReader {
  private byteOffset: number;
  private bitOffset = 0;

  public constructor(
    private readonly bytes: Uint8Array,
    startOffset = 0
  ) {
    this.byteOffset = startOffset;
  }

  public get offset(): number {
    return this.byteOffset;
  }

  public setOffset(nextOffset: number): void {
    this.byteOffset = nextOffset;
    this.bitOffset = 0;
  }

  public readUnsigned(bitCount: number): number {
    let value = 0;

    for (let index = 0; index < bitCount; index += 1) {
      value = (value << 1) | this.readBit();
    }

    return value >>> 0;
  }

  public readSigned(bitCount: number): number {
    const value = this.readUnsigned(bitCount);
    const signBit = 1 << (bitCount - 1);

    if ((value & signBit) === 0) {
      return value;
    }

    return value - (1 << bitCount);
  }

  public align(): void {
    if (this.bitOffset === 0) {
      return;
    }

    this.bitOffset = 0;
    this.byteOffset += 1;
  }

  private readBit(): number {
    const byte = this.bytes[this.byteOffset] ?? 0;
    const bit = (byte >> (7 - this.bitOffset)) & 1;

    this.bitOffset += 1;
    if (this.bitOffset === 8) {
      this.bitOffset = 0;
      this.byteOffset += 1;
    }

    return bit;
  }
}
