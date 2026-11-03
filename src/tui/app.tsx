import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useInput, useStdout } from 'ink';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { diagnose, type Diagnostic } from '../app/diagnostics.js';
import {
  applyDeployment, deploymentRevision, deploymentSecrets, planDeployment,
  readDeployment, startDeployment, type DeploymentPlan, type DeploymentResult,
} from '../app/deployment.js';
import {
  readIspState, validateIspDraft, testIsp, planIspChange, applyIspPlan,
  type IspPlan, type IspState, type IspTestResult,
} from '../app/isp.js';
import { safeText, type ApplicationIO, type OperationEvent } from '../app/system.js';
import { deploymentListeners, probePorts, type PortProbe } from '../adapters/port-probe.js';
import { parsePorts } from '../core/ports.js';
import { detectPublicIp } from '../core/keys.js';
import type { IspSocks } from '../model.js';
import { wrapLine } from './input.js';
import type { Control } from './controls.js';
import type { AppProps, Flow, OperationResult, Screen } from './types.js';
import {
  AppFrame, ChecksView, DiscardView, HelpView, HomeView, InfoView, IspView,
  NetworkView, ProgressView, ResultView, ReviewView, screenTitle, stageLabels,
} from './views.js';

export function App({ projectDir, env, finish, signal }: AppProps) {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
  const [screen, setScreen] = useState<Screen>('home');
  const [flow, setFlow] = useState<Flow>('setup');
  const [focus, setFocusState] = useState(0);
  const focusRef = useRef(0);
  const setFocus = (next: number | ((value: number) => number)) => {
    focusRef.current = typeof next === 'function' ? next(focusRef.current) : next;
    setReveal(false);
    setFocusState(focusRef.current);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [checks, setChecks] = useState<Diagnostic[]>([]);
  const [state, setState] = useState(() => readDeployment(projectDir));
  const [network, setNetwork] = useState({ address: '', ss: '8388', vless: '8443' });
  const [probes, setProbes] = useState<PortProbe[]>([]);
  const [suggestion, setSuggestion] = useState<{ ports: { ss: number; vless: number }; probes: PortProbe[] }>();
  const [allowUnknown, setAllowUnknown] = useState(false);
  const [ispEnabled, setIspEnabled] = useState(false);
  const [ispState, setIspState] = useState<IspState>();
  const [isp, setIsp] = useState({ host: '', port: '1080', user: '', pass: '', egress: '' });
  const [keepUser, setKeepUser] = useState(false);
  const [keepPass, setKeepPass] = useState(false);
  const [tested, setTested] = useState<IspTestResult>();
  const [deploymentPlan, setDeploymentPlan] = useState<DeploymentPlan>();
  const [ispPlan, setIspPlan] = useState<IspPlan>();
  const [events, setEvents] = useState<OperationEvent[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [result, setResult] = useState<OperationResult>();
  const [info, setInfo] = useState<{ title: string; lines: string[] }>({ title: '', lines: [] });
  const [infoOffset, setInfoOffset] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const previousScreen = useRef<Screen>('home');
  const infoBack = useRef<Screen>('home');
  const startRevision = useRef<string | undefined>(undefined);
  const pendingExit = useRef<number | undefined>(undefined);
  const lastCode = useRef(0);
  const callback = useRef<() => void>(() => {});
  const color = env.NO_COLOR === undefined ? 'cyan' : undefined;
  const diskSecrets = useMemo(() => deploymentSecrets(projectDir), [projectDir, state, ispState]);
  const secrets = useMemo(() => [
    ...diskSecrets, isp.user, isp.pass, ispState?.draft?.user ?? '', ispState?.draft?.pass ?? '',
  ].filter(Boolean), [diskSecrets, isp.user, isp.pass, ispState]);
  const clean = (text: string) => safeText(text, secrets);
  const go = (next: Screen) => {
    setScreen(next);
    setFocus(0);
    setError('');
    setReveal(false);
    setInfoOffset(0);
  };
  const resetDraft = () => {
    setIsp({ host: '', port: '1080', user: '', pass: '', egress: '' });
    setIspState(undefined);
    setKeepUser(false);
    setKeepPass(false);
    setIspPlan(undefined);
    setDeploymentPlan(undefined);
    setTested(undefined);
    setNetwork({ address: '', ss: '8388', vless: '8443' });
    setProbes([]);
    setSuggestion(undefined);
    setIspEnabled(false);
    setAllowUnknown(false);
    setDirty(false);
  };
  const leave = (next: () => void) => {
    if (dirty) {
      if (screen !== 'discard') previousScreen.current = screen;
      callback.current = next;
      go('discard');
    } else next();
  };
  const home = () => {
    resetDraft();
    setState(readDeployment(projectDir));
    go('home');
  };
  const onEvent = (event: OperationEvent) => setEvents((old) => [
    ...old.filter((item) => item.stage !== event.stage),
    { ...event, message: clean(event.message) },
  ]);
  const onLog = (text: string) => setLogs((old) => [...old, ...clean(text).split('\n').filter(Boolean)].slice(-30));
  const io = (): ApplicationIO => ({ projectDir, env, signal: controller.current?.signal, onEvent, onLog });
  const ispIO = () => ({
    projectDir, env, signal: controller.current?.signal, stdout: onLog, stderr: onLog,
    onEvent: (event: { phase: string; status: OperationEvent['status']; message?: string }) => onEvent({
      stage: event.phase,
      status: event.status,
      message: event.message ?? stageLabels[event.phase] ?? event.phase,
    }),
  });
  const task = async (work: () => Promise<void>, progress = false) => {
    if (controller.current) return;
    controller.current = new AbortController();
    setBusy(true);
    setError('');
    setElapsed(0);
    if (progress) {
      setEvents([]);
      setLogs([]);
      go('progress');
    }
    try {
      await work();
    } catch (error) {
      setError(clean((error as Error).message ?? '操作失败。'));
      if (progress) {
        lastCode.current = controller.current.signal.aborted ? 130 : 1;
        setResult({ ok: false, message: clean((error as Error).message), lines: [] });
        go('result');
      }
    } finally {
      setBusy(false);
      controller.current = undefined;
      if (pendingExit.current !== undefined) finish(pendingExit.current);
    }
  };
  const diagnostics = () => task(async () => {
    setChecks([]);
    await diagnose({ ...io(), isp: ispEnabled || flow === 'isp-add', onCheck: (check) => setChecks((old) => [...old, check]) });
  });
  const getIsp = (): IspSocks => {
    if (!/^[0-9]+$/.test(isp.port)) throw new Error('代理端口必须是 1–65535 的十进制整数。');
    return validateIspDraft({
      host: isp.host.trim(),
      port: Number(isp.port),
      user: keepUser ? ispState?.draft?.user ?? '' : isp.user,
      pass: keepPass ? ispState?.draft?.pass ?? '' : isp.pass,
      egressIp: isp.egress.trim(),
    });
  };
  const changeIsp = (field: keyof typeof isp, value: string) => {
    setIsp((old) => ({ ...old, [field]: value }));
    setTested(undefined);
    setIspPlan(undefined);
    setDirty(true);
  };
  const changeNetwork = (field: keyof typeof network, value: string) => {
    setNetwork((old) => ({ ...old, [field]: value }));
    setProbes([]);
    setSuggestion(undefined);
    setAllowUnknown(false);
    setDeploymentPlan(undefined);
    setDirty(true);
  };
  const prepareSetup = () => {
    resetDraft();
    setFlow('setup');
    go('checks');
    setChecks([]);
  };
  const prepareIsp = () => {
    if (state.kind !== 'ready') throw new Error('请先修复部署文件或旧版入站，再维护 ISP；可查看运行条件与端口信息。');
    const existing = readIspState(projectDir);
    setIspState(existing);
    setFlow('isp-add');
    setIspEnabled(true);
    setIsp({
      host: existing.draft?.host ?? '', port: String(existing.draft?.port ?? 1080),
      user: '', pass: '', egress: existing.draft?.egressIp ?? '',
    });
    setKeepUser(!!existing.draft?.user);
    setKeepPass(!!existing.draft?.pass);
    setTested(undefined);
    setDirty(false);
    go('isp');
  };
  const previewSetup = (withIsp: boolean) => {
    if (!probes.length) throw new Error('请先检查端口。');
    if (probes.some((port) => port.state === 'occupied')) throw new Error('存在端口冲突，请修改并重新检查。');
    if (probes.some((port) => port.state === 'unknown') && !allowUnknown) throw new Error('部分端口状态未知，请明确选择接受未知结果后继续。');
    setDeploymentPlan(planDeployment(projectDir, {
      serverAddress: network.address,
      ports: { ss: network.ss, vless: network.vless },
      ...(withIsp ? { isp: getIsp() } : {}),
    }, allowUnknown));
    go('review');
  };
  const showDeploymentResult = (value: DeploymentResult) => {
    lastCode.current = value.ok ? 0 : value.cancelled ? 130 : 1;
    setResult({
      ok: value.ok,
      message: clean(value.message),
      lines: [...value.created.map((name) => `已创建 ${name}`), ...value.warnings.map(clean)],
    });
    setDirty(false);
    setState(readDeployment(projectDir));
    go('result');
  };
  const apply = () => task(async () => {
    if (flow === 'setup' && deploymentPlan) showDeploymentResult(await applyDeployment(io(), deploymentPlan));
    else if ((flow === 'isp-add' || flow === 'isp-remove') && ispPlan) {
      const value = await applyIspPlan(ispIO(), ispPlan);
      lastCode.current = value.ok ? 0 : value.cancelled ? 130 : 1;
      setResult({
        ok: value.ok,
        message: clean(value.ok ? 'ISP 操作完成；实际应用域名路由与外网可达性需单独验证。' : value.error ?? 'ISP 操作失败。'),
        lines: [
          `文件状态：${value.files}`, `服务状态：${value.service}`,
          `文件恢复：${value.recovery.files}；服务恢复：${value.recovery.service}`,
          ...(value.backupDir ? [`备份：${value.backupDir}`] : []),
          ...value.recovery.errors.map(clean), ...value.warnings.map(clean),
        ],
      });
      setDirty(false);
      setState(readDeployment(projectDir));
      go('result');
    } else if (flow === 'start') showDeploymentResult(await startDeployment(io(), startRevision.current));
    else throw new Error('操作计划已失效，请重新预览。');
  }, true);

  useEffect(() => {
    const resize = () => setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.on('resize', resize);
    return () => { stdout.off('resize', resize); };
  }, [stdout]);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    if (!reveal) return;
    const timer = setTimeout(() => setReveal(false), 10000);
    return () => clearTimeout(timer);
  }, [reveal]);
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

  const infoLines = info.lines.filter(Boolean).flatMap((line) => wrapLine(clean(line), Math.max(10, size.columns - 2)));
  const infoPageSize = Math.max(2, size.rows - 10);
  const controls: Control[] = [];
  const action = (id: string, label: string, activate: Control['activate']) => controls.push({ id, label, activate });
  const field = (id: string, label: string, value: string, change: (value: string) => void, secret = false, placeholder = '') => controls.push({
    id, label, kind: 'field', value, change, secret, placeholder,
    activate: () => setFocus((old) => Math.min(old + 1, controls.length - 1)),
  });
  if (screen === 'home') {
    if (state.kind === 'empty') action('setup', '开始部署', prepareSetup);
    else if (state.kind === 'ready') action('start', '启动并检查（先预览）', () => {
      startRevision.current = deploymentRevision(projectDir);
      setFlow('start');
      go('review');
    });
    action('checks', '检查运行条件', () => { setFlow('start'); setChecks([]); go('checks'); });
    action('ports', '端口与服务器信息', () => {
      setInfo({
        title: '端口与服务器信息（只读）',
        lines: [
          `服务器：${state.serverAddress ?? '尚未配置'}`,
          ...state.listeners.map((listener) => `${listener}：来自 config.json，运行归属未检查`),
          ...state.problems, '已有部署修改端口留待后续版本；不自动覆盖配置。',
        ],
      });
      go('info');
    });
    action('isp', 'ISP 配置', prepareIsp);
    action('client', '客户端导入说明', () => {
      setInfo({
        title: '客户端导入',
        lines: [
          existsSync(join(projectDir, 'clash.yaml')) ? join(projectDir, 'clash.yaml') : '尚未生成 clash.yaml。',
          '将文件安全传输到本地，导入 Mihomo 客户端。',
          '配置含凭据，切勿公开分享或提交到版本库。',
          `请自行放行：${state.listeners.join('、') || '以部署后的配置为准'}`,
          '本机监听检查无法证明云安全组与外网可达性。',
        ],
      });
      go('info');
    });
    action('quit', '退出', () => finish(lastCode.current));
  } else if (screen === 'checks') {
    action('recheck', busy ? '正在检查…' : '运行 / 重新检查', diagnostics);
    for (const check of checks) action(`check-${check.id}`, `[${check.status}] ${check.summary}`, () => {
      setInfo({ title: check.summary, lines: [check.detail, check.remediation ?? '', `检查时间：${check.checkedAt}`] });
      infoBack.current = 'checks';
      go('info');
    });
    if (flow === 'setup') action('next', '继续填写地址与端口', () => {
      if (!checks.length || checks.some((check) => check.blocks)) throw new Error('请先执行检查并处理所有阻塞项。');
      go('network');
    });
    action('back', '返回首页', () => leave(home));
  } else if (screen === 'network') {
    field('address', '服务器公网 IP / 域名', network.address, (value) => changeNetwork('address', value), false, '输入公网 IP 或域名');
    field('ss', 'Shadowsocks 2022 · TCP + UDP', network.ss, (value) => changeNetwork('ss', value));
    field('vless', 'VLESS / REALITY · TCP', network.vless, (value) => changeNetwork('vless', value));
    action('detect', '检测公网 IP 候选（需访问外部查询服务）', () => task(async () => {
      const value = await detectPublicIp(undefined, controller.current?.signal);
      if (controller.current?.signal.aborted) return;
      if (!value) throw new Error('公网 IP 检测失败，请手动输入。');
      changeNetwork('address', value);
    }));
    action('probe', '检查本机端口', () => task(async () => {
      const ports = parsePorts({ ss: network.ss, vless: network.vless });
      setProbes(await probePorts(deploymentListeners(ports), io()));
    }));
    action('suggest', '生成高位端口建议（接受后才修改字段）', () => task(async () => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const ss = randomInt(20000, 60000), vless = randomInt(20000, 60000);
        if (ss === vless) continue;
        const results = await probePorts(deploymentListeners({ ss, vless }), io());
        if (results.every((value) => value.state === 'free')) {
          setSuggestion({ ports: { ss, vless }, probes: results });
          return;
        }
      }
      throw new Error('未能找到可确认的候选端口，请手动选择。');
    }));
    if (suggestion) action('accept-suggestion', `接受建议：SS ${suggestion.ports.ss} / VLESS ${suggestion.ports.vless}`, () => {
      setNetwork((old) => ({ ...old, ss: String(suggestion.ports.ss), vless: String(suggestion.ports.vless) }));
      setProbes(suggestion.probes);
      setSuggestion(undefined);
      setAllowUnknown(false);
      setDirty(true);
    });
    if (probes.some((value) => value.state === 'unknown')) action('unknown', `${allowUnknown ? '[x]' : '[ ]'} 接受未知端口结果，仍由启动结果决定`, () => setAllowUnknown((value) => !value));
    action('next', '下一步：可选 ISP', () => {
      if (!network.address.trim()) throw new Error('请输入服务器公网 IP 或域名。');
      if (!probes.length || probes.some((value) => value.state === 'occupied')) throw new Error('请检查端口并处理冲突。');
      go('isp');
    });
    action('defaults', '恢复默认端口 8388 / 8443', () => { changeNetwork('ss', '8388'); changeNetwork('vless', '8443'); });
    action('back', '返回运行条件', () => go('checks'));
  } else if (screen === 'isp') {
    if (flow === 'setup') action('enable', `${ispEnabled ? '[x]' : '[ ]'} 启用 ISP SOCKS5`, () => { setIspEnabled((value) => !value); setDirty(true); });
    if (ispEnabled) {
      field('isp-host', '代理主机 IP（IPv4 / IPv6）', isp.host, (value) => changeIsp('host', value));
      field('isp-port', '代理端口', isp.port, (value) => changeIsp('port', value));
      if (keepUser) action('replace-user', '用户名：保留已有（Enter 修改）', () => { setKeepUser(false); setTested(undefined); setDirty(true); });
      else field('isp-user', '用户名 · 1–255 UTF-8 字节', isp.user, (value) => changeIsp('user', value), true);
      if (keepPass) action('replace-pass', '密码：保留已有（Enter 更换）', () => { setKeepPass(false); setTested(undefined); setDirty(true); });
      else field('isp-pass', '密码 · 不会移除前后空格', isp.pass, (value) => changeIsp('pass', value), true);
      field('isp-egress', '期望出口 IP · 留空使用代理入口 IP', isp.egress, (value) => changeIsp('egress', value));
      if (ispState?.draft) action('keep', '恢复使用 .env 中已有凭据与期望出口', () => {
        setKeepUser(true);
        setKeepPass(true);
        setIsp((old) => ({ ...old, user: '', pass: '', egress: ispState.draft?.egressIp ?? '' }));
        setTested(undefined);
        setDirty(true);
      });
      action('test', '测试代理与出口（经代理访问 HTTPS 查询服务）', () => task(async () => setTested(await testIsp(ispIO(), getIsp()))));
    }
    action('preview', '预览变更', () => {
      if (flow === 'setup') previewSetup(ispEnabled);
      else {
        setIspPlan(planIspChange(ispIO(), { action: 'add', isp: getIsp() }));
        go('review');
      }
    });
    if (ispState?.operation || ispState?.operationIssue) action('operation', '查看上次 ISP 操作与恢复记录', () => {
      setInfo({
        title: 'ISP 操作记录',
        lines: [
          ispState.operationIssue ?? '', ...JSON.stringify(ispState.operation ?? {}, null, 2).split('\n'),
          '未完成记录不会自动覆盖；请核对备份、文件与服务后再手动处理记录。',
        ],
      });
      infoBack.current = 'isp';
      go('info');
    });
    if (flow !== 'setup') action('remove', '移除 ISP（先预览）', () => {
      setIspPlan(planIspChange(ispIO(), { action: 'remove' }));
      setFlow('isp-remove');
      go('review');
    });
    action('back', flow === 'setup' ? '上一步：地址与端口' : '取消并返回首页', () => flow === 'setup' ? go('network') : leave(home));
  } else if (screen === 'review') {
    action('apply', flow === 'setup' ? '创建并启动' : flow === 'start' ? '启动并检查' : ispPlan?.restart === 'required' ? '保存并重启 sing-box' : '应用并按计划检查', apply);
    action('edit', '返回修改 / 取消', () => flow === 'setup' || flow === 'isp-add' ? go('isp') : home());
    if (ispPlan && flow !== 'setup' && flow !== 'start') action('route-details', '查看计划中的 ISP 路由条件', () => {
      setInfo({
        title: 'ISP 路由计划',
        lines: [
          `默认出口：${ispPlan.summary.routeFinal}`,
          ...ispPlan.summary.routeRules.map((rule) => clean(JSON.stringify(rule))),
          '按当前规则顺序应用；前置终止规则可能影响匹配结果。',
        ],
      });
      infoBack.current = 'review';
      go('info');
    });
  } else if (screen === 'result') {
    action('details', '查看阶段与脱敏日志', () => {
      setInfo({
        title: '操作详情',
        lines: [...events.map((event) => `[${event.status}] ${stageLabels[event.stage] ?? event.stage}：${event.message}`), ...logs],
      });
      infoBack.current = 'result';
      go('info');
    });
    action('home', '返回首页', home);
  } else if (screen === 'info') {
    if (infoLines.length > infoPageSize) {
      action('previous', '上一页', () => setInfoOffset((value) => Math.max(0, value - infoPageSize)));
      action('next', '下一页', () => setInfoOffset((value) => Math.min(Math.max(0, infoLines.length - infoPageSize), value + infoPageSize)));
    }
    action('back', '返回', () => {
      if (infoBack.current !== 'home') {
        const previous = infoBack.current;
        infoBack.current = 'home';
        go(previous);
      } else home();
    });
  } else if (screen === 'discard') {
    action('stay', '保留草稿，继续编辑', () => go(previousScreen.current));
    action('discard', '丢弃草稿并继续', () => { resetDraft(); callback.current(); });
  } else if (screen === 'help') action('back', '返回', () => go(previousScreen.current));

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (busy) {
        controller.current?.abort(new Error('操作已取消，正在完成安全停止或恢复。'));
        setError('正在安全停止或恢复，请稍候。');
      } else leave(() => finish(130));
      return;
    }
    // Draft confirmation must remain usable while the terminal is undersized.
    if ((size.columns < 60 || size.rows < 18) && screen !== 'discard') return;
    if (busy) return;
    if (key.ctrl && input === 'r' && controls[focusRef.current]?.secret) {
      setReveal((value) => !value);
      return;
    }
    if (key.escape) {
      if (screen === 'help' || screen === 'discard') go(previousScreen.current);
      else if (screen !== 'home') leave(home);
      return;
    }
    if (key.tab || ((key.downArrow || key.upArrow) && controls[focusRef.current]?.kind !== 'field')) {
      const offset = key.shift || key.upArrow ? -1 : 1;
      setFocus((old) => (old + offset + controls.length) % Math.max(1, controls.length));
      return;
    }
    if (key.return) {
      const selected = controls[focusRef.current];
      setError('');
      Promise.resolve().then(() => selected?.activate()).catch((error) => setError(clean((error as Error).message)));
      return;
    }
    if (input === '?' && controls[focusRef.current]?.kind !== 'field') {
      previousScreen.current = screen;
      go('help');
    }
  });

  return (
    <AppFrame
      projectDir={projectDir}
      title={screenTitle(screen, flow, info.title)}
      size={size}
      screen={screen}
      controls={controls}
      focus={focus}
      busy={busy}
      reveal={reveal}
      color={color}
      error={error ? clean(error) : ''}
    >
      {screen === 'home' && <HomeView state={state} clean={clean} />}
      {screen === 'checks' && (
        <ChecksView busy={busy} elapsed={elapsed} count={checks.length} blocked={checks.filter((check) => check.blocks).length} />
      )}
      {screen === 'network' && <NetworkView probes={probes} />}
      {screen === 'isp' && <IspView flow={flow} ispState={ispState} tested={tested} busy={busy} elapsed={elapsed} clean={clean} />}
      {screen === 'review' && <ReviewView flow={flow} deploymentPlan={deploymentPlan} ispPlan={ispPlan} />}
      {screen === 'progress' && <ProgressView elapsed={elapsed} rows={size.rows} events={events} logs={logs} />}
      {screen === 'result' && result && <ResultView result={result} projectDir={projectDir} clean={clean} />}
      {screen === 'info' && <InfoView lines={infoLines} offset={infoOffset} pageSize={infoPageSize} />}
      {screen === 'discard' && <DiscardView />}
      {screen === 'help' && <HelpView />}
    </AppFrame>
  );
}
