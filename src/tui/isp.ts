import { useState } from 'react';
import {
  readIspState, validateIspDraft, testIsp, planIspChange, applyIspPlan,
  type IspPlan, type IspState, type IspTestResult,
} from '../app/isp.js';
import type { DeploymentState } from '../app/deployment.js';
import type { IspSocks } from '../model.js';
import type { ControlBuilder } from './controls.js';
import type { Navigation } from './navigation.js';
import type { Operation } from './operation.js';

const emptyDraft = () => ({ host: '', port: '1080', user: '', pass: '', egress: '' });

/** ISP drafts retain credentials separately from the editable, initially blank fields. */
export function useIsp(projectDir: string, navigation: Navigation) {
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<IspState>();
  const [draft, setDraft] = useState(emptyDraft);
  const [keepUser, setKeepUser] = useState(false);
  const [keepPass, setKeepPass] = useState(false);
  const [tested, setTested] = useState<IspTestResult>();
  const [plan, setPlan] = useState<IspPlan>();
  const secrets = [draft.user, draft.pass, state?.draft?.user ?? '', state?.draft?.pass ?? ''];
  const reset = () => {
    setDraft(emptyDraft());
    setState(undefined);
    setKeepUser(false);
    setKeepPass(false);
    setPlan(undefined);
    setTested(undefined);
    setEnabled(false);
  };
  const getDraft = (): IspSocks => {
    if (!/^[0-9]+$/.test(draft.port)) throw new Error('代理端口必须是 1–65535 的十进制整数。');
    return validateIspDraft({
      host: draft.host.trim(),
      port: Number(draft.port),
      user: keepUser ? state?.draft?.user ?? '' : draft.user,
      pass: keepPass ? state?.draft?.pass ?? '' : draft.pass,
      egressIp: draft.egress.trim(),
    });
  };
  const change = (field: keyof typeof draft, value: string) => {
    setDraft((old) => ({ ...old, [field]: value }));
    setTested(undefined);
    setPlan(undefined);
    navigation.setDirty(true);
  };
  const prepare = (deployment: DeploymentState) => {
    if (deployment.kind !== 'ready') throw new Error('请先修复部署文件或旧版入站，再维护 ISP；可查看运行条件与端口信息。');
    const existing = readIspState(projectDir);
    setState(existing);
    navigation.setFlow('isp-add');
    setEnabled(true);
    setDraft({
      host: existing.draft?.host ?? '', port: String(existing.draft?.port ?? 1080),
      user: '', pass: '', egress: existing.draft?.egressIp ?? '',
    });
    setKeepUser(!!existing.draft?.user);
    setKeepPass(!!existing.draft?.pass);
    setTested(undefined);
    navigation.setDirty(false);
    navigation.go('isp');
  };
  const apply = async (operation: Operation, refresh: () => void) => {
    if (!plan) throw new Error('操作计划已失效，请重新预览。');
    const value = await applyIspPlan(operation.ispIO(), plan);
    operation.complete({
      ok: value.ok,
      message: operation.clean(value.ok ? 'ISP 操作完成；实际应用域名路由与外网可达性需单独验证。' : value.error ?? 'ISP 操作失败。'),
      lines: [
        `文件状态：${value.files}`, `服务状态：${value.service}`,
        `文件恢复：${value.recovery.files}；服务恢复：${value.recovery.service}`,
        ...(value.backupDir ? [`备份：${value.backupDir}`] : []),
        ...value.recovery.errors.map(operation.clean), ...value.warnings.map(operation.clean),
      ],
    }, value.ok ? 0 : value.cancelled ? 130 : 1);
    refresh();
  };
  const controls = (
    { action, field }: ControlBuilder,
    operation: Operation,
    previewSetup: () => void,
    home: () => void,
  ) => {
    if (navigation.flow === 'setup') action('enable', `${enabled ? '[x]' : '[ ]'} 启用 ISP SOCKS5`, () => { setEnabled((value) => !value); navigation.setDirty(true); });
    if (enabled) {
      field('isp-host', '代理主机 IP（IPv4 / IPv6）', draft.host, (value) => change('host', value));
      field('isp-port', '代理端口', draft.port, (value) => change('port', value));
      if (keepUser) action('replace-user', '用户名：保留已有（Enter 修改）', () => { setKeepUser(false); setTested(undefined); navigation.setDirty(true); });
      else field('isp-user', '用户名 · 1–255 UTF-8 字节', draft.user, (value) => change('user', value), true);
      if (keepPass) action('replace-pass', '密码：保留已有（Enter 更换）', () => { setKeepPass(false); setTested(undefined); navigation.setDirty(true); });
      else field('isp-pass', '密码 · 不会移除前后空格', draft.pass, (value) => change('pass', value), true);
      field('isp-egress', '期望出口 IP · 留空使用代理入口 IP', draft.egress, (value) => change('egress', value));
      if (state?.draft) action('keep', '恢复使用 .env 中已有凭据与期望出口', () => {
        setKeepUser(true);
        setKeepPass(true);
        setDraft((old) => ({ ...old, user: '', pass: '', egress: state.draft?.egressIp ?? '' }));
        setTested(undefined);
        navigation.setDirty(true);
      });
      action('test', '测试代理与出口（经代理访问 HTTPS 查询服务）', () => operation.task(async () => setTested(await testIsp(operation.ispIO(), getDraft()))));
    }
    action('preview', '预览变更', () => {
      if (navigation.flow === 'setup') previewSetup();
      else {
        setPlan(planIspChange(operation.ispIO(), { action: 'add', isp: getDraft() }));
        navigation.go('review');
      }
    });
    if (state?.operation || state?.operationIssue) action('operation', '查看上次 ISP 操作与恢复记录', () => {
      navigation.showInfo('ISP 操作记录', [
        state.operationIssue ?? '', ...JSON.stringify(state.operation ?? {}, null, 2).split('\n'),
        '未完成记录不会自动覆盖；请核对备份、文件与服务后再手动处理记录。',
      ], 'isp');
    });
    if (navigation.flow !== 'setup') action('remove', '移除 ISP（先预览）', () => {
      setPlan(planIspChange(operation.ispIO(), { action: 'remove' }));
      navigation.setFlow('isp-remove');
      navigation.go('review');
    });
    action('back', navigation.flow === 'setup' ? '上一步：地址与端口' : '取消并返回首页', () => navigation.flow === 'setup' ? navigation.go('network') : navigation.leave(home));
  };
  const routeControl = ({ action }: ControlBuilder, operation: Operation) => {
    if (plan && navigation.flow !== 'setup' && navigation.flow !== 'start') action('route-details', '查看计划中的 ISP 路由条件', () => {
      navigation.showInfo('ISP 路由计划', [
        `默认出口：${plan.summary.routeFinal}`,
        ...plan.summary.routeRules.map((rule) => operation.clean(JSON.stringify(rule))),
        '按当前规则顺序应用；前置终止规则可能影响匹配结果。',
      ], 'review');
    });
  };

  return { enabled, state, tested, plan, secrets, reset, getDraft, prepare, apply, controls, routeControl };
}
