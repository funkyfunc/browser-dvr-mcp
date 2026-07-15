// Mock-free unit tests for the bounded RingBuffer primitive.
import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../../src/core/types.js';

describe('RingBuffer', () => {
  it('rejects a non-positive or non-integer capacity', () => {
    expect(() => new RingBuffer<number>(0)).toThrow(RangeError);
    expect(() => new RingBuffer<number>(-1)).toThrow(RangeError);
    expect(() => new RingBuffer<number>(1.5)).toThrow(RangeError);
  });

  it('returns items in insertion order while under capacity', () => {
    const rb = new RingBuffer<number>(5);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    expect(rb.toArray()).toEqual([1, 2, 3]);
    expect(rb.size).toBe(3);
  });

  it('overwrites the oldest items on wrap-around and stays bounded', () => {
    const rb = new RingBuffer<number>(3);
    for (let i = 1; i <= 5; i++) rb.push(i);
    expect(rb.size).toBe(3);
    expect(rb.toArray()).toEqual([3, 4, 5]);
  });

  it('filters over the logical contents', () => {
    const rb = new RingBuffer<number>(4);
    for (let i = 1; i <= 6; i++) rb.push(i);
    // Contents are [3,4,5,6]
    expect(rb.filter((n) => n % 2 === 0)).toEqual([4, 6]);
  });

  it('clear() resets to empty', () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    rb.clear();
    expect(rb.size).toBe(0);
    expect(rb.toArray()).toEqual([]);
  });
});
