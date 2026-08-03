import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ONBOARDING_EVENTS,
  ONBOARDING_STAGES,
  advanceOnboardingStage,
  createSingleReplayScript,
  findOnboardingTask,
  getOnboardingGuide
} from '../src/shared/taskCenterOnboarding.js';

test('tutorial advances only through real recording events', () => {
  const flow = [
    [ONBOARDING_STAGES.WELCOME, ONBOARDING_EVENTS.START, ONBOARDING_STAGES.RECORDING_ENTRY],
    [ONBOARDING_STAGES.RECORDING_ENTRY, ONBOARDING_EVENTS.OPEN_RECORDING, ONBOARDING_STAGES.DEVICE_SELECT],
    [ONBOARDING_STAGES.DEVICE_SELECT, ONBOARDING_EVENTS.SELECT_DEVICE, ONBOARDING_STAGES.SNAPSHOT],
    [ONBOARDING_STAGES.SNAPSHOT, ONBOARDING_EVENTS.SNAPSHOT_READY, ONBOARDING_STAGES.RECORD_TAP],
    [ONBOARDING_STAGES.RECORD_TAP, ONBOARDING_EVENTS.TAP_RECORDED, ONBOARDING_STAGES.REPLAY],
    [ONBOARDING_STAGES.REPLAY, ONBOARDING_EVENTS.TASK_FINISHED, ONBOARDING_STAGES.RESULT]
  ];

  for (const [stage, event, expected] of flow) {
    assert.equal(advanceOnboardingStage(stage, event), expected);
  }

  assert.equal(
    advanceOnboardingStage(ONBOARDING_STAGES.DEVICE_SELECT, ONBOARDING_EVENTS.SNAPSHOT_READY),
    ONBOARDING_STAGES.DEVICE_SELECT
  );
  assert.equal(
    advanceOnboardingStage(ONBOARDING_STAGES.REPLAY, ONBOARDING_EVENTS.REPLAY_STARTED),
    ONBOARDING_STAGES.REPLAY
  );
});

test('every interactive stage points to one real task-center target', () => {
  assert.deepEqual(getOnboardingGuide(ONBOARDING_STAGES.RECORDING_ENTRY), {
    selector: '[data-task-center-guide="recording-entry"]',
    step: 1,
    title: '进入录制操作',
    description: '点击“录制操作”，进入简化录制页面。'
  });
  assert.equal(getOnboardingGuide(ONBOARDING_STAGES.DEVICE_SELECT).step, 2);
  assert.equal(getOnboardingGuide(ONBOARDING_STAGES.SNAPSHOT).step, 3);
  assert.equal(getOnboardingGuide(ONBOARDING_STAGES.RECORD_TAP).step, 4);
  assert.equal(getOnboardingGuide(ONBOARDING_STAGES.REPLAY).step, 5);
  assert.equal(getOnboardingGuide(ONBOARDING_STAGES.WELCOME), null);
  assert.equal(getOnboardingGuide(ONBOARDING_STAGES.RESULT), null);
});

test('recorded tutorial draft is normalized to one replay without extra analysis', () => {
  const source = {
    id: 'draft-1',
    name: '录制操作流程',
    mode: 'stress',
    continueOnError: true,
    loop: { count: 99, durationMs: 60000, intervalMs: 3000, continueOnError: true },
    acceptance: { minSuccessRate: 95, failOnCrash: true, failOnAnr: true, thresholds: { cpu: 80 } },
    report: { includeAiSummary: true, includePerformance: true },
    steps: [{ id: 'tap-1', type: 'tap', x: 100, y: 200 }]
  };

  const replay = createSingleReplayScript(source);
  assert.equal(replay.mode, 'replay');
  assert.deepEqual(replay.loop, {
    count: 1,
    durationMs: 0,
    intervalMs: 0,
    continueOnError: false
  });
  assert.deepEqual(replay.acceptance, {
    minSuccessRate: 0,
    failOnCrash: false,
    failOnAnr: false,
    thresholds: {}
  });
  assert.deepEqual(replay.report, {
    includeAiSummary: false,
    includePerformance: false
  });
  assert.notEqual(replay.steps, source.steps);
  assert.deepEqual(source.loop.count, 99);
});

test('task lookup prefers active task then falls back to history', () => {
  const active = [{ id: 'task-1', status: 'running' }];
  const history = [
    { id: 'task-1', status: 'success' },
    { id: 'task-2', status: 'failed' }
  ];
  assert.equal(findOnboardingTask('task-1', active, history).status, 'running');
  assert.equal(findOnboardingTask('task-2', active, history).status, 'failed');
  assert.equal(findOnboardingTask('', active, history), null);
});
