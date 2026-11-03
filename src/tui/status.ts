import { useState } from 'react';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { diagnose, type Diagnostic } from '../app/diagnostics.js';
import type { DeploymentState } from '../app/deployment.js';
import type { ControlBuilder } from './controls.js';
import { wrapLine } from './input.js';
import type { Navigation } from './navigation.js';
import type { Operation } from './operation.js';
import { stageLabels } from './views.js';

interface HomeActions {
  setup(): void;
  start(): void;
  isp(): void;
  quit(): void;
}

/** Read-only pages share diagnostic details, result logs, and paginated information. */
export function useStatus(projectDir: string, navigation: Navigation, operation: Operation) {
  const [checks, setChecks] = useState<Diagnostic[]>([]);
  const clearChecks = () => setChecks([]);
  const homeControls = ({ action }: ControlBuilder, state: DeploymentState, actions: HomeActions) => {
    if (state.kind === 'empty') action('setup', '开始部署', actions.setup);
    else if (state.kind === 'ready') action('start', '启动并检查（先预览）', actions.start);
    action('checks', '检查运行条件', () => { navigation.setFlow('start'); clearChecks(); navigation.go('checks'); });
    action('ports', '端口与服务器信息', () => {
      navigation.showInfo('端口与服务器信息（只读）', [
        `服务器：${state.serverAddress ?? '尚未配置'}`,
        ...state.listeners.map((listener) => `${listener}：来自 config.json，运行归属未检查`),
        ...state.problems, '已有部署修改端口留待后续版本；不自动覆盖配置。',
      ]);
    });
    action('isp', 'ISP 配置', actions.isp);
    action('client', '客户端导入说明', () => {
      navigation.showInfo('客户端导入', [
        existsSync(join(projectDir, 'clash.yaml')) ? join(projectDir, 'clash.yaml') : '尚未生成 clash.yaml。',
        '将文件安全传输到本地，导入 Mihomo 客户端。',
        '配置含凭据，切勿公开分享或提交到版本库。',
        `请自行放行：${state.listeners.join('、') || '以部署后的配置为准'}`,
        '本机监听检查无法证明云安全组与外网可达性。',
      ]);
    });
    action('quit', '退出', actions.quit);
  };
  const checksControls = ({ action }: ControlBuilder, ispEnabled: boolean, home: () => void) => {
    action('recheck', operation.busy ? '正在检查…' : '运行 / 重新检查', () => operation.task(async () => {
      clearChecks();
      await diagnose({
        ...operation.io(), isp: ispEnabled || navigation.flow === 'isp-add',
        onCheck: (check) => setChecks((old) => [...old, check]),
      });
    }));
    for (const check of checks) action(`check-${check.id}`, `[${check.status}] ${check.summary}`, () => {
      navigation.showInfo(check.summary, [check.detail, check.remediation ?? '', `检查时间：${check.checkedAt}`], 'checks');
    });
    if (navigation.flow === 'setup') action('next', '继续填写地址与端口', () => {
      if (!checks.length || checks.some((check) => check.blocks)) throw new Error('请先执行检查并处理所有阻塞项。');
      navigation.go('network');
    });
    action('back', '返回首页', () => navigation.leave(home));
  };
  const resultControls = ({ action }: ControlBuilder, home: () => void) => {
    action('details', '查看阶段与脱敏日志', () => {
      navigation.showInfo('操作详情', [
        ...operation.events.map((event) => `[${event.status}] ${stageLabels[event.stage] ?? event.stage}：${event.message}`),
        ...operation.logs,
      ], 'result');
    });
    action('home', '返回首页', home);
  };
  const infoPage = (size: { columns: number; rows: number }) => ({
    lines: navigation.info.lines.filter(Boolean).flatMap((line) => wrapLine(operation.clean(line), Math.max(10, size.columns - 2))),
    pageSize: Math.max(2, size.rows - 10),
  });
  const infoControls = (
    { action }: ControlBuilder,
    page: ReturnType<typeof infoPage>,
    home: () => void,
  ) => {
    if (page.lines.length > page.pageSize) {
      action('previous', '上一页', () => navigation.setInfoOffset((value) => Math.max(0, value - page.pageSize)));
      action('next', '下一页', () => navigation.setInfoOffset((value) => Math.min(Math.max(0, page.lines.length - page.pageSize), value + page.pageSize)));
    }
    action('back', '返回', () => navigation.returnFromInfo(home));
  };

  return { checks, clearChecks, homeControls, checksControls, resultControls, infoPage, infoControls };
}
