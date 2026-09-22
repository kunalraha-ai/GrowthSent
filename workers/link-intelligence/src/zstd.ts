import { ZSTDDecoder } from "zstddec";

let decoder: ZSTDDecoder | undefined;
let initPromise: Promise<void> | undefined;

/**
 * Lazy singleton for the zstddec WASM decoder.
 *
 * zstddec embeds its wasm as a base64 data URI and uses `WebAssembly.instantiate`
 * (not the disallowed `new WebAssembly.Module`), so it passes the Worker upload
 * validator.
 */
export async function getZstdCompressor(): Promise<(input: Uint8Array, uncompressedSize: number) => Uint8Array> {
  if (!decoder) {
    decoder = new ZSTDDecoder();
  }
  if (!initPromise) {
    initPromise = decoder.init();
  }
  await initPromise;

  return (input: Uint8Array, uncompressedSize: number) => {
    return decoder!.decode(input, uncompressedSize);
  };
}
