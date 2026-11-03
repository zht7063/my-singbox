import { useEffect, useRef, useState } from 'react';
import type { Flow, Screen } from './types.js';

/** Navigation owns focus, secret visibility, and draft/return destinations together. */
export function useNavigation() {
  const [screen, setScreen] = useState<Screen>('home');
  const [flow, setFlow] = useState<Flow>('setup');
  const [focus, setFocusState] = useState(0);
  const focusRef = useRef(0);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [info, setInfo] = useState({ title: '', lines: [] as string[] });
  const [infoOffset, setInfoOffset] = useState(0);
  const previousScreen = useRef<Screen>('home');
  const infoBack = useRef<Screen>('home');
  const callback = useRef<() => void>(() => {});

  const setFocus = (next: number | ((value: number) => number)) => {
    focusRef.current = typeof next === 'function' ? next(focusRef.current) : next;
    setReveal(false);
    setFocusState(focusRef.current);
  };
  const go = (next: Screen) => {
    setScreen(next);
    setFocus(0);
    setError('');
    setReveal(false);
    setInfoOffset(0);
  };
  const leave = (next: () => void) => {
    if (dirty) {
      if (screen !== 'discard') previousScreen.current = screen;
      callback.current = next;
      go('discard');
    } else next();
  };
  const showInfo = (title: string, lines: string[], back?: Screen) => {
    setInfo({ title, lines });
    if (back) infoBack.current = back;
    go('info');
  };
  const returnFromInfo = (home: () => void) => {
    if (infoBack.current !== 'home') {
      const previous = infoBack.current;
      infoBack.current = 'home';
      go(previous);
    } else home();
  };
  const help = () => {
    previousScreen.current = screen;
    go('help');
  };
  const back = () => go(previousScreen.current);
  const discard = (reset: () => void) => { reset(); callback.current(); };

  useEffect(() => {
    if (!reveal) return;
    const timer = setTimeout(() => setReveal(false), 10000);
    return () => clearTimeout(timer);
  }, [reveal]);

  return {
    screen, flow, setFlow, focus, focusRef, setFocus, error, setError,
    dirty, setDirty, reveal, setReveal, info, infoOffset, setInfoOffset,
    go, leave, showInfo, returnFromInfo, help, back, discard,
  };
}

export type Navigation = ReturnType<typeof useNavigation>;
