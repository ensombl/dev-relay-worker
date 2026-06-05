export const WS_CHUNK = 240 * 1024;

export type ReqHeaderFrame = {
  id: number;
  type: "req";
  m: string;
  p: string;
  q: string;
  h: Record<string, string>;
};

export type ReqBodyFrame = {
  id: number;
  type: "req_body";
  b64: string;
  more: boolean;
};

export type ResHeaderFrame = {
  id: number;
  type: "res";
  s: number;
  h: Record<string, string>;
};

export type ResBodyFrame = {
  id: number;
  type: "res_body";
  b64: string;
  more: boolean;
};

export type RequestFrame = ReqHeaderFrame | ReqBodyFrame;
export type ResponseFrame = ResHeaderFrame | ResBodyFrame;
export type RelayFrame = RequestFrame | ResponseFrame;

type Base64Global = typeof globalThis & {
  atob(value: string): string;
  btoa(value: string): string;
};

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return (globalThis as Base64Global).btoa(binary);
}

export function base64ToBytes(value: string | undefined): Uint8Array {
  const binary = (globalThis as Base64Global).atob(value ?? "");
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}
