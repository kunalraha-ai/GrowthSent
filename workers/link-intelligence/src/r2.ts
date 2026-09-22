/**
 * Minimal R2-backed AsyncBuffer for hyparquet.
 *
 * Uses the Workers R2 bucket binding for authenticated, range-based reads. Each
 * `slice()` maps to an R2 `get()` with a byte range. The worker only needs the
 * bucket binding; no S3 credentials are exposed in code.
 */

export class R2ParquetBuffer {
  byteLength: number;

  constructor(
    private bucket: R2Bucket,
    private key: string,
    size: number,
  ) {
    this.byteLength = size;
  }

  slice(start: number, end?: number): ArrayBuffer | Promise<ArrayBuffer> {
    const length = end === undefined ? this.byteLength - start : end - start;
    if (length <= 0) {
      return new ArrayBuffer(0);
    }
    return this.readRange(start, length);
  }

  private async readRange(offset: number, length: number): Promise<ArrayBuffer> {
    const object = await this.bucket.get(this.key, {
      range: { offset, length },
    });
    if (!object) {
      throw new Error(`R2 object not found: ${this.key}`);
    }
    if (!object.body) {
      // Range preconditions can cause R2Object to be returned without body.
      throw new Error(`R2 object body unavailable for: ${this.key}`);
    }
    return object.arrayBuffer();
  }
}

export async function objectSize(bucket: R2Bucket, key: string): Promise<number | null> {
  const object = await bucket.head(key);
  return object?.size ?? null;
}
