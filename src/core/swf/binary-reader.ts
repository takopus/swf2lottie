import { ConversionError, type ConversionIssue } from "../issues.js";

export class BinaryReader {
  private readonly view: DataView;
  private offset = 0;

  public constructor(private readonly buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
  }

  public get position(): number {
    return this.offset;
  }

  public get length(): number {
    return this.buffer.byteLength;
  }

  public readUi8(): number {
    this.ensureAvailable(1);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  public readUi16(): number {
    this.ensureAvailable(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  public readUi32(): number {
    this.ensureAvailable(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  public readBytes(length: number): Uint8Array {
    this.ensureAvailable(length);
    const value = new Uint8Array(this.buffer, this.offset, length);
    this.offset += length;
    return value.slice();
  }

  public skip(length: number): void {
    this.ensureAvailable(length);
    this.offset += length;
  }

  private ensureAvailable(length: number): void {
    if (this.offset + length <= this.buffer.byteLength) {
      return;
    }

    const issues: ConversionIssue[] = [
      {
        code: "malformed_swf",
        severity: "error",
        message: "Unexpected end of SWF stream.",
        details: {
          offset: this.offset,
          requestedBytes: length,
          availableBytes: this.buffer.byteLength - this.offset
        }
      }
    ];

    throw new ConversionError("Malformed SWF stream.", issues);
  }
}
