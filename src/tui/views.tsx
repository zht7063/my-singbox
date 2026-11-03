import React from 'react';
import { Box, Text } from 'ink';
import { join } from 'node:path';
import type { DeploymentPlan, DeploymentState } from '../app/deployment.js';
import type { IspPlan, IspState, IspTestResult } from '../app/isp.js';
import type { OperationEvent } from '../app/system.js';
import type { PortProbe } from '../adapters/port-probe.js';
import { ControlList, type Control } from './controls.js';
import type { Flow, OperationResult, Screen } from './types.js';

export const stageLabels: Record<string, string> = {
  preflight: '运行条件',
  baseline: '文件基线',
  'proxy-test': '代理出口',
  'isp-test': '代理出口',
  keys: '生成凭据',
  validate: '候选校验',
  candidate: '候选校验',
  files: '创建文件',
  backup: '备份',
  install: '保存',
  restart: '重建服务',
  verify: '检查服务',
  'restore-files': '恢复文件',
  'restore-service': '恢复服务',
  complete: '完成',
  start: '启动检查',
};

export function screenTitle(screen: Screen, flow: Flow, infoTitle: string): string {
  return {
    home: '状态首页',
    checks: flow === 'setup' ? '首次部署 · 1/5 运行条件' : '运行条件与诊断',
    network: '首次部署 · 2/5 地址与端口',
    isp: flow === 'setup' ? '首次部署 · 3/5 可选 ISP' : 'ISP 出口配置',
    review: flow === 'setup' ? '首次部署 · 4/5 变更预览' : '变更预览',
    progress: '执行中',
    result: '执行结果',
    info: infoTitle,
    discard: '草稿尚未保存',
    help: '键盘帮助',
  }[screen];
}

interface AppFrameProps {
  projectDir: string;
  title: string;
  size: { columns: number; rows: number };
  screen: Screen;
  controls: Control[];
  focus: number;
  busy: boolean;
  reveal: boolean;
  color?: string;
  error: string;
  children: React.ReactNode;
}

export function AppFrame({
  projectDir, title, size, screen, controls, focus, busy, reveal, color, error, children,
}: AppFrameProps) {
  const small = size.columns < 60 || size.rows < 18;
  const available = Math.max(2, size.rows - (screen === 'home' ? 12 : screen === 'isp' || screen === 'network' ? 12 : 9));
  return (
    <Box flexDirection="column" width={Math.max(20, size.columns - 1)}>
      <Text bold color={color}>My sing-box · {title}</Text>
      <Text dimColor wrap="truncate-middle">{projectDir}</Text>
      {small && screen !== 'discard' ? (
        <>
          <Text>请将终端调整到至少 60 列 × 18 行；草稿已保留。</Text>
          <Text>当前 {size.columns} × {size.rows} · Ctrl+C 退出 / 请求安全停止</Text>
        </>
      ) : (
        <>
          {children}
          <ControlList
            controls={controls}
            focus={focus}
            available={available}
            columns={size.columns}
            busy={busy}
            reveal={reveal}
            color={color}
          />
          {error && <Text bold>{error}</Text>}
          <Text dimColor>Tab 切换 · Enter 确认 · Esc 返回 · ? 帮助 · Ctrl+C {busy ? '安全停止' : '退出'}</Text>
        </>
      )}
    </Box>
  );
}

export function HomeView({ state, clean }: { state: DeploymentState; clean(text: string): string }) {
  return (
    <>
      <Text>部署：{{ empty: '尚未初始化', ready: '配置已存在；服务运行状态未检查', incomplete: '文件不完整', inconsistent: '配置需要核对' }[state.kind]}</Text>
      <Text>ISP：{state.isp ? '已配置；应用路由未验证' : '未配置'}</Text>
      {state.operation && state.operation.state !== 'complete' && (
        <Text>! 上次操作 {state.operation.state} / {state.operation.stage}；请先核对文件与服务。</Text>
      )}
      {state.ispOperation && state.ispOperation.status !== 'succeeded' && (
        <Text>! 上次 ISP 操作 {state.ispOperation.status} / {stageLabels[state.ispOperation.phase] ?? state.ispOperation.phase}；进入 ISP 查看记录。</Text>
      )}
      {state.operationIssue && <Text>{state.operationIssue}</Text>}
      {state.problems.slice(0, 2).map((problem) => <Text key={problem}>{clean(problem)}</Text>)}
    </>
  );
}

export function ChecksView({ busy, elapsed, count, blocked }: {
  busy: boolean;
  elapsed: number;
  count: number;
  blocked: number;
}) {
  return (
    <Text>
      {busy ? `正在检查 · ${elapsed}s` : count ? `已完成 ${count} 项，${blocked} 项阻塞；Enter 查看详情` : '按 Enter 开始只读检查，不安装软件、不提权。'}
    </Text>
  );
}

export function NetworkView({ probes }: { probes: PortProbe[] }) {
  return (
    <>
      <Text dimColor>端口修改后旧检查失效；本地空闲不等于公网可达。</Text>
      {probes.map((probe) => (
        <Text key={`${probe.port}/${probe.protocol}`}>
          {probe.port}/{probe.protocol} [{({ free: '未发现占用', occupied: '冲突', unknown: '未知' })[probe.state]}] · {probe.source}
        </Text>
      ))}
    </>
  );
}

export function IspView({ flow, ispState, tested, busy, elapsed, clean }: {
  flow: Flow;
  ispState?: IspState;
  tested?: IspTestResult;
  busy: boolean;
  elapsed: number;
  clean(text: string): string;
}) {
  return (
    <>
      <Text dimColor>{flow === 'setup' ? '可跳过；启用后需要用户名和密码。' : '只修改 .env / config.json，保留现有服务端路由。'}</Text>
      {ispState?.differences.length ? <Text>! .env 与 config.json 存在差异；“保留”使用 .env 值。</Text> : null}
      {tested && <Text>{tested.ok ? `出口校验通过：${tested.actualIp}` : `测试未通过：${clean(tested.error ?? '已取消')}`}</Text>}
      <Text dimColor>{busy ? `测试中 ${elapsed}s，Ctrl+C 取消` : '测试经代理请求 api.ipify.org 等 HTTPS 服务；提交时重新校验。'}</Text>
    </>
  );
}

export function ReviewView({ flow, deploymentPlan, ispPlan }: {
  flow: Flow;
  deploymentPlan?: DeploymentPlan;
  ispPlan?: IspPlan;
}) {
  return (
    <>
      {flow === 'setup' && deploymentPlan && (
        <>
          <Text>服务器 {deploymentPlan.serverAddress}</Text>
          <Text>监听 {deploymentPlan.listeners.join(' · ')}</Text>
          <Text>ISP {deploymentPlan.isp ? '启用，提交时检测出口' : '未启用'} · 镜像 {deploymentPlan.version}</Text>
          <Text>创建 compose.yaml / .env / config.json / clash.yaml</Text>
          <Text>凭据文件 0600；必要时拉取镜像；启动并检查服务。</Text>
          <Text>自行放行 {deploymentPlan.listeners.join('、')}</Text>
        </>
      )}
      {flow !== 'setup' && ispPlan && (
        <>
          <Text>{ispPlan.action === 'remove' ? '移除 ISP 出站及可安全移除的顶层规则' : `ISP ${ispPlan.summary.after?.host}:${ispPlan.summary.after?.port}`}</Text>
          <Text>文件：{ispPlan.files.map((file) => `${file.action} ${file.path}`).join('、') || '无文件变更'}</Text>
          <Text>凭据：{ispPlan.summary.credentials} · 默认出口：{ispPlan.summary.routeFinal}</Text>
          <Text>服务动作：{ispPlan.restart}；重建会中断现有连接。</Text>
          <Text>不修改 clash.yaml；备份 {ispPlan.summary.backupRoot ?? '无需新备份'}</Text>
          {ispPlan.summary.retiredPorts.length ? <Text>! 将移除旧 ISP 入站，请手动迁移旧客户端。</Text> : null}
        </>
      )}
      {flow === 'start' && (
        <>
          <Text>使用当前 compose.yaml 和 config.json 启动 sing-box。</Text>
          <Text>会拉取所需镜像并执行容器、配置、TCP/UDP 检查。</Text>
          <Text>不重新生成或覆盖现有凭据与配置。</Text>
        </>
      )}
    </>
  );
}

export function ProgressView({ elapsed, rows, events, logs }: {
  elapsed: number;
  rows: number;
  events: OperationEvent[];
  logs: string[];
}) {
  return (
    <>
      <Text>已耗时 {elapsed}s · Ctrl+C 请求安全停止 / 恢复</Text>
      {events.slice(-Math.max(2, rows - 12)).map((event) => (
        <Text key={event.stage}>[{event.status}] {stageLabels[event.stage] ?? event.stage} · {event.message}</Text>
      ))}
      {logs.slice(-2).map((line, index) => <Text key={index} dimColor wrap="truncate-end">{line}</Text>)}
    </>
  );
}

export function ResultView({ result, projectDir, clean }: {
  result: OperationResult;
  projectDir: string;
  clean(text: string): string;
}) {
  return (
    <>
      <Text bold>{result.ok ? '操作完成' : '操作未完成'}：{result.message}</Text>
      {result.lines.slice(0, 4).map((line, index) => <Text key={index}>{clean(line)}</Text>)}
      <Text>导入文件：{join(projectDir, 'clash.yaml')}</Text>
    </>
  );
}

export function InfoView({ lines, offset, pageSize }: { lines: string[]; offset: number; pageSize: number }) {
  return <>{lines.slice(offset, offset + pageSize).map((line, index) => <Text key={index}>{line}</Text>)}</>;
}

export function DiscardView() {
  return <Text>继续会清空当前操作草稿；尚未写入配置文件。</Text>;
}

export function HelpView() {
  return (
    <>
      <Text>Tab / Shift+Tab：移动焦点；菜单内 ↑ / ↓ 移动。</Text>
      <Text>Enter：激活按钮；输入框内转到下一个控件。</Text>
      <Text>Esc：返回；有草稿先确认。Ctrl+C：退出 / 安全停止。</Text>
      <Text>Ctrl+R：临时显示当前输入的凭据，10 秒或失焦后隐藏。</Text>
      <Text>?：非输入框内打开帮助。NO_COLOR 禁用颜色。</Text>
    </>
  );
}
