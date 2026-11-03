import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { editInput, graphemes, inputWindow } from '../../src/tui/input.js';
import { detectPublicIp } from '../../src/core/keys.js';

describe('terminal line input', () => {
  it('deletes a whole combined grapheme and preserves valid Unicode', () => {
    const value = '密👩‍💻é';
    expect(graphemes(value)).toHaveLength(3);
    expect(editInput({ value, cursor: 3 }, '', { backspace: true })).toEqual({ value: '密👩‍💻', cursor: 2 });
  });
  it('keeps global shortcuts out of credential values', () => {
    const state = { value: 'password', cursor: 4 };
    expect(editInput(state, 'r', { ctrl: true })).toBe(state);
    expect(editInput(state, '', { escape: true })).toBe(state);
    expect(editInput(state, '\t', { tab: true })).toBe(state);
  });
  it('inserts paste at the cursor and retains invalid control characters for validation', () => {
    expect(editInput({ value: 'ab', cursor: 1 }, '雪\n', {})).toEqual({ value: 'a雪\nb', cursor: 3 });
  });
  it('bounds the visible line while retaining the full value and cursor', () => {
    const value = '中文'.repeat(60);
    const view = inputWindow(value, 100, 30, false);
    expect(view.left).toBe(true);
    expect(stringWidth(view.before + view.cursor + view.after) + Number(view.left) + Number(view.right)).toBeLessThanOrEqual(30);
    const masked = inputWindow('secret\u001b[2J', 10, 12, true);
    expect(masked.before + masked.cursor + masked.after).not.toContain('secret');
  });
});

it('public IP detection stops retrying after cancellation', async () => {
  const controller = new AbortController();
  let calls = 0;
  await expect(detectPublicIp({ httpGet: async (_url, _family, signal) => { calls++; controller.abort(new Error('cancelled')); signal?.throwIfAborted(); return ''; } }, controller.signal)).rejects.toThrow('cancelled');
  expect(calls).toBe(1);
});
