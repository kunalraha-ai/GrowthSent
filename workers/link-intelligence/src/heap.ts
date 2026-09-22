/**
 * Tiny min-heap used to keep the top-K rows while streaming a Parquet file.
 */

export interface HeapItem<T> {
  score: number;
  item: T;
}

export class TopHeap<T> {
  private heap: HeapItem<T>[] = [];

  constructor(private capacity: number) {
    if (capacity <= 0) throw new Error("capacity must be positive");
  }

  push(score: number, item: T): void {
    if (this.heap.length < this.capacity) {
      this.heap.push({ score, item });
      this.bubbleUp(this.heap.length - 1);
    } else if (score > this.heap[0].score) {
      this.heap[0] = { score, item };
      this.bubbleDown(0);
    }
  }

  size(): number {
    return this.heap.length;
  }

  toSorted(): T[] {
    const sorted = [...this.heap].sort((a, b) => b.score - a.score || compareItems(a.item, b.item));
    return sorted.map((entry) => entry.item);
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heap[parent].score <= this.heap[i].score) break;
      [this.heap[parent], this.heap[i]] = [this.heap[i], this.heap[parent]];
      i = parent;
    }
  }

  private bubbleDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      let smallest = i;
      const left = (i << 1) + 1;
      const right = left + 1;
      if (left < n && this.heap[left].score < this.heap[smallest].score) smallest = left;
      if (right < n && this.heap[right].score < this.heap[smallest].score) smallest = right;
      if (smallest === i) break;
      [this.heap[i], this.heap[smallest]] = [this.heap[smallest], this.heap[i]];
      i = smallest;
    }
  }
}

function compareItems<T>(a: T, b: T): number {
  if (a === b) return 0;
  if (typeof a === "object" && a && typeof b === "object" && b) {
    const aStr = JSON.stringify(a);
    const bStr = JSON.stringify(b);
    return aStr < bStr ? -1 : aStr > bStr ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
