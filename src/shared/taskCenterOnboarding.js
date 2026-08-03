export const ONBOARDING_STAGES = Object.freeze({
  WELCOME: 'welcome',
  RECORDING_ENTRY: 'recording_entry',
  DEVICE_SELECT: 'device_select',
  SNAPSHOT: 'snapshot',
  RECORD_TAP: 'record_tap',
  REPLAY: 'replay',
  RESULT: 'result'
});

export const ONBOARDING_EVENTS = Object.freeze({
  START: 'start',
  OPEN_RECORDING: 'open_recording',
  SELECT_DEVICE: 'select_device',
  SNAPSHOT_READY: 'snapshot_ready',
  TAP_RECORDED: 'tap_recorded',
  REPLAY_STARTED: 'replay_started',
  TASK_FINISHED: 'task_finished'
});

const NEXT_STAGE_BY_EVENT = Object.freeze({
  [ONBOARDING_STAGES.WELCOME]: {
    [ONBOARDING_EVENTS.START]: ONBOARDING_STAGES.RECORDING_ENTRY
  },
  [ONBOARDING_STAGES.RECORDING_ENTRY]: {
    [ONBOARDING_EVENTS.OPEN_RECORDING]: ONBOARDING_STAGES.DEVICE_SELECT
  },
  [ONBOARDING_STAGES.DEVICE_SELECT]: {
    [ONBOARDING_EVENTS.SELECT_DEVICE]: ONBOARDING_STAGES.SNAPSHOT
  },
  [ONBOARDING_STAGES.SNAPSHOT]: {
    [ONBOARDING_EVENTS.SNAPSHOT_READY]: ONBOARDING_STAGES.RECORD_TAP
  },
  [ONBOARDING_STAGES.RECORD_TAP]: {
    [ONBOARDING_EVENTS.TAP_RECORDED]: ONBOARDING_STAGES.REPLAY
  },
  [ONBOARDING_STAGES.REPLAY]: {
    [ONBOARDING_EVENTS.REPLAY_STARTED]: ONBOARDING_STAGES.REPLAY,
    [ONBOARDING_EVENTS.TASK_FINISHED]: ONBOARDING_STAGES.RESULT
  }
});

const GUIDE_BY_STAGE = Object.freeze({
  [ONBOARDING_STAGES.RECORDING_ENTRY]: {
    selector: '[data-task-center-guide="recording-entry"]',
    step: 1,
    title: '进入录制操作',
    description: '点击“录制操作”，进入简化录制页面。'
  },
  [ONBOARDING_STAGES.DEVICE_SELECT]: {
    selector: '[data-task-center-guide="device-select"]',
    step: 2,
    title: '选择在线设备',
    description: '点击一台在线设备，后续录制和回放都会使用它。'
  },
  [ONBOARDING_STAGES.SNAPSHOT]: {
    selector: '[data-task-center-guide="snapshot"]',
    step: 3,
    title: '读取真实界面',
    description: '点击“读取界面”，获取当前设备画面。'
  },
  [ONBOARDING_STAGES.RECORD_TAP]: {
    selector: '[data-task-center-guide="preview"]',
    step: 4,
    title: '录制一次安全点击',
    description: '在设备画面中点击一个你确认安全的位置；该点击会真实发送到设备。'
  },
  [ONBOARDING_STAGES.REPLAY]: {
    selector: '[data-task-center-guide="replay"]',
    step: 5,
    title: '回放刚才的点击',
    description: '点击“开始回放”，在这台设备上执行一次刚录制的操作。'
  }
});

export function advanceOnboardingStage(stage, event) {
  return NEXT_STAGE_BY_EVENT[stage]?.[event] || stage;
}

export function getOnboardingGuide(stage) {
  return GUIDE_BY_STAGE[stage] || null;
}

export function createSingleReplayScript(script) {
  const source = script && typeof script === 'object' ? script : {};
  return {
    ...source,
    mode: 'replay',
    continueOnError: false,
    loop: {
      count: 1,
      durationMs: 0,
      intervalMs: 0,
      continueOnError: false
    },
    acceptance: {
      minSuccessRate: 0,
      failOnCrash: false,
      failOnAnr: false,
      thresholds: {}
    },
    report: {
      includeAiSummary: false,
      includePerformance: false
    },
    steps: (Array.isArray(source.steps) ? source.steps : []).map(step => ({ ...step }))
  };
}

export function findOnboardingTask(taskId, activeTasks, history) {
  if (!taskId) return null;
  return (Array.isArray(activeTasks) ? activeTasks : []).find(task => task.id === taskId)
    || (Array.isArray(history) ? history : []).find(task => task.id === taskId)
    || null;
}

export function isTerminalTask(task) {
  return ['success', 'failed', 'cancelled'].includes(task?.status);
}
