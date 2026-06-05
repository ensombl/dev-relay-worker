import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64 } from "../src/protocol.js";

describe("relay protocol helpers", () => {
  it("round-trips bytes across multiple base64 chunks", () => {
    const bytes = new Uint8Array(0x8000 + 17);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 251;
    }

    const decoded = base64ToBytes(bytesToBase64(bytes));

    expect(decoded).toEqual(bytes);
  });

  it("treats missing base64 values as an empty body chunk", () => {
    expect(base64ToBytes(undefined)).toEqual(new Uint8Array());
  });
});
