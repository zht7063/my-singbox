import { useEffect, useMemo, useRef, useState } from 'react';
import { deploymentSecrets, type DeploymentState } from '../app/deployment.js';
import type { IspIO, IspState } from '../app/isp.js';
import { safeText, type ApplicationIO, type OperationEvent } from '../app/system.js';
import type { Navigation } from './navigation.js';
import type { AppProps, OperationResult } from './types.js';
import { stageLabels } from './views.js';

interface SecretSources {
  deployment: DeploymentState;
  isp?: IspState;
  values: string[];
}

/** One operation lifecycle serves diagnostics, probes, deployment, and ISP recovery. */
export function useOperation(
  { projectDir, env, finish, signal }: AppProps,
  navigation: Navigation,
  sources: SecretSources,
) {
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [events, setEvents] = useState<OperationEvent[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [result, setResult] = useState<OperationResult>();
  const controller = useRef<AbortController | undefined>(undefined);
  const pendingExit = useRef<number | undefined>(undefined);
  const lastCode = useRef(0);
  const diskSecrets = useMemo(() => deploymentSecrets(projectDir), [projectDir, sources.deployment, sources.isp]);
  const secrets = [...diskSecrets, ...sources.values].filter(Boolean);
  const clean = (text: string) => safeText(text, secrets);
  const onEvent = (event: OperationEvent) => setEvents((old) => [
    ...old.filter((item) => item.stage !== event.stage),
    { ...event, message: clean(event.message) },
  ]);
  const onLog = (text: string) => setLogs((old) => [...old, ...clean(text).split('\n').filter(Boolean)].slice(-30));
  const io = (): ApplicationIO => ({ projectDir, env, signal: controller.current?.signal, onEvent, onLog });
  const ispIO = (): IspIO => ({
    projectDir, env, signal: controller.current?.signal, stdout: onLog, stderr: onLog,
    onEvent: (event) => onEvent({
      stage: event.phase,
      status: event.status,
      message: event.message ?? stageLabels[event.phase] ?? event.phase,
    }),
  });
  const complete = (value: OperationResult, code: number) => {
    lastCode.current = code;
    setResult(value);
    navigation.setDirty(false);
    navigation.go('result');
  };
  const task = async (work: () => Promise<void>, progress = false) => {
    if (controller.current) return;
    controller.current = new AbortController();
    setBusy(true);
    navigation.setError('');
    setElapsed(0);
    if (progress) {
      setEvents([]);
      setLogs([]);
      navigation.go('progress');
    }
    try {
      await work();
    } catch (error) {
      navigation.setError(clean((error as Error).message ?? '操作失败。'));
      if (progress) {
        lastCode.current = controller.current.signal.aborted ? 130 : 1;
        setResult({ ok: false, message: clean((error as Error).message), lines: [] });
        navigation.go('result');
      }
    } finally {
      setBusy(false);
      controller.current = undefined;
      if (pendingExit.current !== undefined) finish(pendingExit.current);
    }
  };
  const cancel = () => {
    controller.current?.abort(new Error('操作已取消，正在完成安全停止或恢复。'));
    navigation.setError('正在安全停止或恢复，请稍候。');
  };

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    const abort = () => {
      pendingExit.current = typeof signal.reason === 'number' ? signal.reason : 130;
      if (controller.current) controller.current.abort(new Error('操作已中断，正在安全停止或恢复。'));
      else finish(pendingExit.current);
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    return () => signal.removeEventListener('abort', abort);
  }, [signal, finish]);

  return { busy, elapsed, events, logs, result, lastCode, clean, io, ispIO, task, complete, cancel };
}

export type Operation = ReturnType<typeof useOperation>;
