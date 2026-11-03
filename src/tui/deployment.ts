import { useRef, useState } from 'react';
import { randomInt } from 'node:crypto';
import {
  applyDeployment, deploymentRevision, planDeployment, readDeployment, startDeployment,
  type DeploymentPlan, type DeploymentResult,
} from '../app/deployment.js';
import { deploymentListeners, probePorts, type PortProbe } from '../adapters/port-probe.js';
import { detectPublicIp } from '../core/keys.js';
import { parsePorts } from '../core/ports.js';
import type { IspSocks } from '../model.js';
import type { ControlBuilder } from './controls.js';
import type { Navigation } from './navigation.js';
import type { Operation } from './operation.js';

const emptyNetwork = () => ({ address: '', ss: '8388', vless: '8443' });

/** Deployment state, network validation, and reviewed start/deploy plans. */
export function useDeployment(projectDir: string, navigation: Navigation) {
  const [state, setState] = useState(() => readDeployment(projectDir));
  const [network, setNetwork] = useState(emptyNetwork);
  const [probes, setProbes] = useState<PortProbe[]>([]);
  const [suggestion, setSuggestion] = useState<{ ports: { ss: number; vless: number }; probes: PortProbe[] }>();
  const [allowUnknown, setAllowUnknown] = useState(false);
  const [plan, setPlan] = useState<DeploymentPlan>();
  const startRevision = useRef<string | undefined>(undefined);
  const refresh = () => setState(readDeployment(projectDir));
  const reset = () => {
    setNetwork(emptyNetwork());
    setProbes([]);
    setSuggestion(undefined);
    setAllowUnknown(false);
    setPlan(undefined);
  };
  const changeNetwork = (field: keyof typeof network, value: string) => {
    setNetwork((old) => ({ ...old, [field]: value }));
    setProbes([]);
    setSuggestion(undefined);
    setAllowUnknown(false);
    setPlan(undefined);
    navigation.setDirty(true);
  };
  const prepareStart = () => {
    startRevision.current = deploymentRevision(projectDir);
    navigation.setFlow('start');
    navigation.go('review');
  };
  const preview = (getIsp?: () => IspSocks) => {
    if (!probes.length) throw new Error('请先检查端口。');
    if (probes.some((port) => port.state === 'occupied')) throw new Error('存在端口冲突，请修改并重新检查。');
    if (probes.some((port) => port.state === 'unknown') && !allowUnknown) throw new Error('部分端口状态未知，请明确选择接受未知结果后继续。');
    setPlan(planDeployment(projectDir, {
      serverAddress: network.address,
      ports: { ss: network.ss, vless: network.vless },
      ...(getIsp ? { isp: getIsp() } : {}),
    }, allowUnknown));
    navigation.go('review');
  };
  const showResult = (operation: Operation, value: DeploymentResult) => {
    operation.complete({
      ok: value.ok,
      message: operation.clean(value.message),
      lines: [...value.created.map((name) => `已创建 ${name}`), ...value.warnings.map(operation.clean)],
    }, value.ok ? 0 : value.cancelled ? 130 : 1);
    refresh();
  };
  const apply = async (operation: Operation) => {
    if (navigation.flow === 'setup' && plan) showResult(operation, await applyDeployment(operation.io(), plan));
    else if (navigation.flow === 'start') showResult(operation, await startDeployment(operation.io(), startRevision.current));
    else throw new Error('操作计划已失效，请重新预览。');
  };
  const controls = ({ action, field }: ControlBuilder, operation: Operation) => {
    field('address', '服务器公网 IP / 域名', network.address, (value) => changeNetwork('address', value), false, '输入公网 IP 或域名');
    field('ss', 'Shadowsocks 2022 · TCP + UDP', network.ss, (value) => changeNetwork('ss', value));
    field('vless', 'VLESS / REALITY · TCP', network.vless, (value) => changeNetwork('vless', value));
    action('detect', '检测公网 IP 候选（需访问外部查询服务）', () => operation.task(async () => {
      const signal = operation.io().signal;
      const value = await detectPublicIp(undefined, signal);
      if (signal?.aborted) return;
      if (!value) throw new Error('公网 IP 检测失败，请手动输入。');
      changeNetwork('address', value);
    }));
    action('probe', '检查本机端口', () => operation.task(async () => {
      const ports = parsePorts({ ss: network.ss, vless: network.vless });
      setProbes(await probePorts(deploymentListeners(ports), operation.io()));
    }));
    action('suggest', '生成高位端口建议（接受后才修改字段）', () => operation.task(async () => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const ss = randomInt(20000, 60000), vless = randomInt(20000, 60000);
        if (ss === vless) continue;
        const results = await probePorts(deploymentListeners({ ss, vless }), operation.io());
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
      navigation.setDirty(true);
    });
    if (probes.some((value) => value.state === 'unknown')) action('unknown', `${allowUnknown ? '[x]' : '[ ]'} 接受未知端口结果，仍由启动结果决定`, () => setAllowUnknown((value) => !value));
    action('next', '下一步：可选 ISP', () => {
      if (!network.address.trim()) throw new Error('请输入服务器公网 IP 或域名。');
      if (!probes.length || probes.some((value) => value.state === 'occupied')) throw new Error('请检查端口并处理冲突。');
      navigation.go('isp');
    });
    action('defaults', '恢复默认端口 8388 / 8443', () => { changeNetwork('ss', '8388'); changeNetwork('vless', '8443'); });
    action('back', '返回运行条件', () => navigation.go('checks'));
  };

  return { state, probes, plan, refresh, reset, prepareStart, preview, apply, controls };
}
