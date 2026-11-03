import React, { useEffect, useState } from 'react';
import { useInput, useStdout } from 'ink';
import { createControls } from './controls.js';
import { useDeployment } from './deployment.js';
import { useIsp } from './isp.js';
import { useNavigation } from './navigation.js';
import { useOperation } from './operation.js';
import { useStatus } from './status.js';
import type { AppProps } from './types.js';
import {
  AppFrame, ChecksView, DiscardView, HelpView, HomeView, InfoView, IspView,
  NetworkView, ProgressView, ResultView, ReviewView, screenTitle,
} from './views.js';

export function App(props: AppProps) {
  const { projectDir, env, finish } = props;
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
  const navigation = useNavigation();
  const deployment = useDeployment(projectDir, navigation);
  const isp = useIsp(projectDir, navigation);
  const operation = useOperation(props, navigation, { deployment: deployment.state, isp: isp.state, values: isp.secrets });
  const status = useStatus(projectDir, navigation, operation);
  const { screen, flow, focusRef, go, setFocus, setError, leave } = navigation;
  const { busy, clean } = operation;
  const resetDraft = () => {
    isp.reset();
    deployment.reset();
    navigation.setDirty(false);
  };
  const home = () => {
    resetDraft();
    deployment.refresh();
    go('home');
  };
  const prepareSetup = () => {
    resetDraft();
    navigation.setFlow('setup');
    go('checks');
    status.clearChecks();
  };
  const apply = () => operation.task(async () => {
    if (flow === 'isp-add' || flow === 'isp-remove') await isp.apply(operation, deployment.refresh);
    else await deployment.apply(operation);
  }, true);

  useEffect(() => {
    const resize = () => setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.on('resize', resize);
    return () => { stdout.off('resize', resize); };
  }, [stdout]);

  const page = status.infoPage(size);
  const builder = createControls(setFocus);
  const { controls, action } = builder;
  if (screen === 'home') status.homeControls(builder, deployment.state, {
    setup: prepareSetup, start: deployment.prepareStart,
    isp: () => isp.prepare(deployment.state), quit: () => finish(operation.lastCode.current),
  });
  else if (screen === 'checks') status.checksControls(builder, isp.enabled, home);
  else if (screen === 'network') deployment.controls(builder, operation);
  else if (screen === 'isp') isp.controls(builder, operation, () => deployment.preview(isp.enabled ? isp.getDraft : undefined), home);
  else if (screen === 'review') {
    action('apply', flow === 'setup' ? '创建并启动' : flow === 'start' ? '启动并检查' : isp.plan?.restart === 'required' ? '保存并重启 sing-box' : '应用并按计划检查', apply);
    action('edit', '返回修改 / 取消', () => flow === 'setup' || flow === 'isp-add' ? go('isp') : home());
    isp.routeControl(builder, operation);
  } else if (screen === 'result') status.resultControls(builder, home);
  else if (screen === 'info') status.infoControls(builder, page, home);
  else if (screen === 'discard') {
    action('stay', '保留草稿，继续编辑', navigation.back);
    action('discard', '丢弃草稿并继续', () => navigation.discard(resetDraft));
  } else if (screen === 'help') action('back', '返回', navigation.back);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (busy) operation.cancel();
      else leave(() => finish(130));
      return;
    }
    // Draft confirmation must remain usable while the terminal is undersized.
    if ((size.columns < 60 || size.rows < 18) && screen !== 'discard') return;
    if (busy) return;
    if (key.ctrl && input === 'r' && controls[focusRef.current]?.secret) {
      navigation.setReveal((value) => !value);
      return;
    }
    if (key.escape) {
      if (screen === 'help' || screen === 'discard') navigation.back();
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
    if (input === '?' && controls[focusRef.current]?.kind !== 'field') navigation.help();
  });

  return (
    <AppFrame
      projectDir={projectDir}
      title={screenTitle(screen, flow, navigation.info.title)}
      size={size}
      screen={screen}
      controls={controls}
      focus={navigation.focus}
      busy={busy}
      reveal={navigation.reveal}
      color={env.NO_COLOR === undefined ? 'cyan' : undefined}
      error={navigation.error ? clean(navigation.error) : ''}
    >
      {screen === 'home' && <HomeView state={deployment.state} clean={clean} />}
      {screen === 'checks' && (
        <ChecksView busy={busy} elapsed={operation.elapsed} count={status.checks.length} blocked={status.checks.filter((check) => check.blocks).length} />
      )}
      {screen === 'network' && <NetworkView probes={deployment.probes} />}
      {screen === 'isp' && <IspView flow={flow} ispState={isp.state} tested={isp.tested} busy={busy} elapsed={operation.elapsed} clean={clean} />}
      {screen === 'review' && <ReviewView flow={flow} deploymentPlan={deployment.plan} ispPlan={isp.plan} />}
      {screen === 'progress' && <ProgressView elapsed={operation.elapsed} rows={size.rows} events={operation.events} logs={operation.logs} />}
      {screen === 'result' && operation.result && <ResultView result={operation.result} projectDir={projectDir} clean={clean} />}
      {screen === 'info' && <InfoView lines={page.lines} offset={navigation.infoOffset} pageSize={page.pageSize} />}
      {screen === 'discard' && <DiscardView />}
      {screen === 'help' && <HelpView />}
    </AppFrame>
  );
}
