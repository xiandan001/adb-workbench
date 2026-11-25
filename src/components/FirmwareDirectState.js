import { useEffect, useRef, useState } from 'react';

export const cancellableDirectPhases = new Set(['preparing', 'confirming', 'waiting', 'choice-required']);
const activeJob = job => Boolean(job && (cancellableDirectPhases.has(job.phase) || ['checking', 'authorizing', 'armed', 'writing', 'verifying'].includes(job.phase)));

function stateFrom(previous, response) {
  if (!response || typeof response !== 'object') return previous;
  return {
    enabled: typeof response.enabled === 'boolean' ? response.enabled : previous?.enabled,
    modes: Array.isArray(response.modes) ? response.modes : previous?.modes,
    job: Object.hasOwn(response, 'job') ? response.job : previous?.job,
    globalBusy: typeof response.busy === 'boolean' ? response.busy : previous?.globalBusy,
    savedTarget: Object.hasOwn(response, 'savedTarget') ? response.savedTarget : previous?.savedTarget,
    toolReady: typeof response.toolReady === 'boolean' ? response.toolReady : previous?.toolReady,
  };
}

export function useFirmwareDirect({ platform, active, api = globalThis.window?.electronAPI }) {
  const [snapshots, setSnapshots] = useState({});
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [readError, setReadError] = useState(null);
  const [setupAction, setSetupAction] = useState(null);
  const revision = useRef(0);
  const command = useRef({ active: false, cancelling: false, sequence: 0 });
  const lastState = useRef({});
  const mounted = useRef(false);
  const snapshot = snapshots[platform];
  const running = activeJob(snapshot?.job);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!active || !api?.firmwareDirectState) return undefined;
    let alive = true;
    let timer;
    async function read() {
      const ticket = revision.current;
      try {
        const result = await api.firmwareDirectState(platform);
        if (!alive || ticket !== revision.current) return;
        if (result?.ok) {
          setReadError(null);
          const next = stateFrom(lastState.current[platform], result);
          lastState.current[platform] = next;
          setSnapshots(previous => ({ ...previous, [platform]: next }));
        } else {
          setReadError({ platform, code: result?.code });
        }
      } catch {
        if (alive && ticket === revision.current) setReadError({ platform });
      } finally {
        if (alive && (command.current.active || command.current.cancelling || lastState.current[platform]?.globalBusy ||
          activeJob(lastState.current[platform]?.job))) timer = setTimeout(read, 800);
      }
    }
    void read();
    return () => { alive = false; clearTimeout(timer); };
  }, [active, platform, api, busy]);

  async function request(caller, cancel = false) {
    const channel = cancel ? 'cancelling' : 'active';
    if (!active || command.current.cancelling || (!cancel && command.current.active)) return;
    command.current[channel] = true;
    if (cancel) setCancelling(true);
    const sequence = ++command.current.sequence;
    setActionError(null);
    setBusy(true);
    try {
      const response = await caller();
      if (!mounted.current || sequence !== command.current.sequence) return;
      revision.current++;
      const next = stateFrom(lastState.current[platform], response);
      lastState.current[platform] = next;
      setSnapshots(previous => ({ ...previous, [platform]: next }));
      if (!response?.ok && !response?.job && !response?.cancelled) setActionError({ platform, code: response?.code });
    } catch {
      if (mounted.current && sequence === command.current.sequence) setActionError({ platform });
    } finally {
      command.current[channel] = false;
      if (mounted.current) {
        setBusy(command.current.active || command.current.cancelling);
        if (cancel) setCancelling(false);
      }
    }
  }

  async function setup(action, caller) {
    if (!active || !['rk', 'mtk'].includes(platform) || running || snapshot?.globalBusy ||
      command.current.active || command.current.cancelling) return;
    setSetupAction(action);
    try {
      await request(caller);
    } finally {
      if (mounted.current) setSetupAction(null);
    }
  }

  return {
    ...snapshot,
    error: actionError?.platform === platform ? actionError : readError?.platform === platform ? readError : null,
    busy, running, cancelling, unavailable: !api?.firmwareDirectState,
    arm: value => request(() => api?.firmwareDirectArm?.(platform, value)),
    choose: value => request(() => api?.firmwareDirectChoose?.(platform, value)),
    enterLoader: id => request(() => api?.firmwareDirectEnterLoader?.(platform, id)),
    cancel: id => request(() => api?.firmwareDirectCancel?.(platform, id), true),
    registerTarget: api?.firmwareDirectRegisterTarget ? () => setup('register', () => api.firmwareDirectRegisterTarget(platform)) : undefined,
    prepareTool: api?.firmwareDirectPrepareTool ? options => setup(options?.local ? 'tool-local' : 'tool', () => options?.local
      ? api.firmwareDirectPrepareTool(platform, { local: true }) : api.firmwareDirectPrepareTool(platform)) : undefined,
    registeringTarget: setupAction === 'register',
    preparingTool: setupAction === 'tool' || setupAction === 'tool-local',
    preparingLocalTool: setupAction === 'tool-local',
  };
}
