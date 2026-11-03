import React, { useEffect, useState } from 'react';
import { Box, Text, useInput, type Key } from 'ink';
import stringWidth from 'string-width';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const graphemes = (text: string): string[] => [...segmenter.segment(text)].map((part) => part.segment);
export interface EditState { value: string; cursor: number }

export function wrapLine(text: string, columns: number): string[] {
  const lines: string[] = []; let line = '', width = 0;
  for (const char of graphemes(text)) {
    if (width + stringWidth(char) > columns && line) { lines.push(line); line = ''; width = 0; }
    line += char; width += stringWidth(char);
  }
  if (line) lines.push(line);
  return lines;
}

/** The cursor indexes graphemes, so deletion never leaves half an emoji or combining sequence. */
export function editInput(state: EditState, input: string, key: Partial<Key>): EditState {
  const chars = graphemes(state.value), cursor = Math.max(0, Math.min(state.cursor, chars.length));
  if (key.ctrl && input === 'a') return { ...state, cursor: 0 };
  if (key.ctrl && input === 'e') return { ...state, cursor: chars.length };
  if (key.ctrl && input === 'u') return { value: chars.slice(cursor).join(''), cursor: 0 };
  if (key.ctrl && input === 'k') return { value: chars.slice(0, cursor).join(''), cursor };
  if (key.ctrl || key.meta || key.tab || key.return || key.escape || key.upArrow || key.downArrow) return state;
  if (key.leftArrow) return { ...state, cursor: Math.max(0, cursor - 1) };
  if (key.rightArrow) return { ...state, cursor: Math.min(chars.length, cursor + 1) };
  if (key.backspace || key.delete) return cursor ? { value: [...chars.slice(0, cursor - 1), ...chars.slice(cursor)].join(''), cursor: cursor - 1 } : state;
  // Bound drafts, including paste, independently of the credential byte validator.
  if (Buffer.byteLength(state.value + input, 'utf8') > 8192) return state;
  return { value: [...chars.slice(0, cursor), input, ...chars.slice(cursor)].join(''), cursor: cursor + graphemes(input).length };
}

export function inputWindow(value: string, cursor: number, columns: number, masked: boolean) {
  const chars = graphemes(value).map((char) => masked ? '*' : char.replace(/[\x00-\x1f\x7f-\x9f]/g, '�'));
  const position = Math.min(cursor, chars.length), width = Math.max(3, columns - 2);
  let start = position, used = 1;
  while (start > 0 && used + stringWidth(chars[start - 1]) <= width) used += stringWidth(chars[--start]);
  let end = start; used = 0;
  while (end < chars.length && used + stringWidth(chars[end]) <= width) used += stringWidth(chars[end++]);
  return { before: chars.slice(start, position).join(''), cursor: chars[position] ?? ' ', after: chars.slice(position + 1, end).join(''), left: start > 0, right: end < chars.length };
}

export function LineInput({ value, onChange, focus, masked, columns, placeholder = '' }: { value: string; onChange(value: string): void; focus: boolean; masked: boolean; columns: number; placeholder?: string }) {
  const [cursor, setCursor] = useState(() => graphemes(value).length);
  useEffect(() => { if (focus) setCursor(graphemes(value).length); }, [focus]);
  useInput((input, key) => {
    const next = editInput({ value, cursor }, input, key);
    setCursor(next.cursor);
    if (next.value !== value) onChange(next.value);
  }, { isActive: focus });
  const visible = inputWindow(value, focus ? cursor : 0, columns, masked);
  return <Box width={columns} overflow="hidden"><Text wrap="truncate-end">{visible.left ? '‹' : ''}{visible.before}{focus ? <Text inverse>{visible.cursor}</Text> : value ? visible.cursor : ''}{visible.after}{visible.right ? '›' : ''}{!value && !focus ? <Text dimColor>{placeholder}</Text> : ''}</Text></Box>;
}
