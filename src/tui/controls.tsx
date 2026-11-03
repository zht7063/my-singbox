import React from 'react';
import { Box, Text } from 'ink';
import { LineInput } from './input.js';

export interface Control {
  id: string;
  label: string;
  kind?: 'field';
  value?: string;
  secret?: boolean;
  placeholder?: string;
  change?(value: string): void;
  activate(): void | Promise<void>;
}

/** Each page builds controls in display order; fields advance through that same list. */
export function createControls(setFocus: (next: (value: number) => number) => void) {
  const controls: Control[] = [];
  const action = (id: string, label: string, activate: Control['activate']) => {
    controls.push({ id, label, activate });
  };
  const field = (id: string, label: string, value: string, change: (value: string) => void, secret = false, placeholder = '') => {
    controls.push({
      id, label, kind: 'field', value, change, secret, placeholder,
      activate: () => setFocus((old) => Math.min(old + 1, controls.length - 1)),
    });
  };
  return { controls, action, field };
}

export type ControlBuilder = ReturnType<typeof createControls>;

export function ControlList({ controls, focus, available, columns, busy, reveal, color }: {
  controls: Control[];
  focus: number;
  available: number;
  columns: number;
  busy: boolean;
  reveal: boolean;
  color?: string;
}) {
  const start = Math.max(0, Math.min(focus - Math.floor(available / 2), controls.length - available));
  const visible = controls.slice(start, start + available);
  const labelWidth = Math.min(36, Math.floor(columns / 2));
  return <>
    {start > 0 && <Text dimColor>↑ 上方还有 {start} 项</Text>}
    {visible.map((control, index) => {
      const selected = start + index === focus;
      return <Box key={control.id} gap={1}>
        <Box width={control.kind === 'field' ? labelWidth : columns - 4} flexShrink={0}>
          <Text wrap="truncate-end" color={selected ? color : undefined}>
            {selected ? '›' : ' '} {control.label}{control.kind === 'field' ? '：' : ''}
          </Text>
        </Box>
        {control.kind === 'field' && <LineInput
          value={control.value ?? ''}
          onChange={control.change!}
          focus={selected && !busy}
          masked={!!control.secret && !(selected && reveal)}
          placeholder={control.placeholder}
          columns={columns - labelWidth - 5}
        />}
      </Box>;
    })}
    {start + visible.length < controls.length && <Text dimColor>
      ↓ 下方还有 {controls.length - start - visible.length} 项（Tab 继续）
    </Text>}
  </>;
}
