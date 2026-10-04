/**
 * 阶段 9：cron 持久化状态机测试（DEV_PLAN 阶段 9 验收：
 * 重复触发/并发无重复副作用、重启恢复、执行中退出、失败暂停）。
 * 每用例独立内存库；语义断言与 schedule/policy 的纯决策测试互为对照。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CronCreateInput } from '../../ipc';
import { CronScheduleError } from './schedule';
import { closeCronStore, createCronStore, CronStoreError } from './store';
import type { CronStore } from './store';

let store: CronStore;

beforeEach(() => {
  store = createCronStore({ dbPath: ':memory:' });
});

afterEach(() => {
  closeCronStore(store);
});

function makeTask(overrides: Partial<CronCreateInput> = {}): string {
  const task = store.createTask({
    name: '晨间整理',
    prompt: '整理收件箱并汇总',
    schedule: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    ...overrides
  });
  return task.id;
}

/** 非法入参试建（期望抛对应错误类） */
function tryCreate(overrides: Record<string, unknown>): void {
  store.createTask({
    name: 'n',
    prompt: 'p',
    schedule: '0 9 * * *',
    ...overrides
  } as CronCreateInput);
}

describe('createTask（保存期校验）', () => {
  it('合法任务：active + nextRunAt 已算出 + 默认值', () => {
    const task = store.createTask({
      name: ' 晨间整理 ',
      prompt: '整理收件箱',
      schedule: '0 9 * * *'
    });
    expect(task.status).toBe('active');
    expect(task.nextRunAt).not.toBeNull();
    expect(task.timezone.length).toBeGreaterThan(0); // 默认系统时区
    expect(task.preauthorized).toEqual([]);
    expect(task.catchup).toBe(true);
    expect(task.maxRetries).toBe(0);
    expect(task.failureLimit).toBe(3);
    expect(task.consecutiveFailures).toBe(0);
    expect(task.pauseReason).toBeNull();
    expect(task.name).toBe('晨间整理'); // trim
  });

  it.each<[Record<string, unknown>, unknown]>([
    [{ schedule: 'bad expr' }, CronScheduleError],
    [{ schedule: '0 0 30 2 *' }, CronScheduleError], // 未来无触发
    [{ timezone: 'Bad/Zone' }, CronScheduleError],
    [{ name: '  ' }, CronStoreError],
    [{ prompt: '' }, CronStoreError],
    [{ preauthorized: ['bad name!'] }, CronStoreError],
    [{ maxRetries: 9 }, CronStoreError],
    [{ failureLimit: 0 }, CronStoreError]
  ])('非法入参拒绝：%j', (overrides, errorClass) => {
    expect(() => tryCreate(overrides)).toThrow(errorClass as ErrorConstructor);
  });
});

describe('updateTask / setTaskEnabled / removeTask（编辑与暂停恢复）', () => {
  it('改表达式 → 重算 nextRunAt、失败计数清零', () => {
    const id = makeTask();
    store.recordFailure(id, '测试失败');
    expect(store.getTask(id)?.consecutiveFailures).toBe(1);

    const patched = store.updateTask(id, { schedule: '*/5 * * * *', name: '新名字' });
    expect(patched.schedule).toBe('*/5 * * * *');
    expect(patched.name).toBe('新名字');
    expect(patched.consecutiveFailures).toBe(0);
    expect(patched.nextRunAt).toBeGreaterThan(Date.now());
  });

  it('未改表达式 → nextRunAt 不变', () => {
    const id = makeTask();
    const before = store.getTask(id)?.nextRunAt;
    const patched = store.updateTask(id, { prompt: '换指令' });
    expect(patched.nextRunAt).toBe(before);
  });

  it('暂停 → paused + 可见原因；恢复 → active + 重算下次触发 + 计数清零', () => {
    const id = makeTask();
    store.pauseTask(id, '连续失败 3 次');
    let task = store.getTask(id)!;
    expect(task.status).toBe('paused');
    expect(task.pauseReason).toBe('连续失败 3 次');

    store.recordFailure(id, '再来一次'); // 暂停状态下计数照常（不隐藏问题）
    task = store.setTaskEnabled(id, true);
    expect(task.status).toBe('active');
    expect(task.pauseReason).toBeNull();
    expect(task.consecutiveFailures).toBe(0);
    expect(task.nextRunAt).toBeGreaterThan(Date.now());
  });

  it('用户暂停（无原因）→ 默认原因「用户暂停」', () => {
    const id = makeTask();
    expect(store.setTaskEnabled(id, false).pauseReason).toBe('用户暂停');
  });

  it('删除任务 → 任务与运行历史一并删除；重复删除返回 false', () => {
    const id = makeTask();
    store.claim(id, Date.now());
    expect(store.removeTask(id)).toBe(true);
    expect(store.getTask(id)).toBeNull();
    expect(store.listRuns(id)).toHaveLength(0);
    expect(store.removeTask(id)).toBe(false);
  });

  it('编辑不存在的任务 → 抛错（fail-visible）', () => {
    expect(() => store.updateTask('nope', { name: 'x' })).toThrow(CronStoreError);
  });
});

describe('claim（幂等键 + 并发防护）', () => {
  it('同一计划时刻 claim 两次 → 第二次 duplicate（无重复运行行）', () => {
    const id = makeTask();
    const at = Date.now();
    const first = store.claim(id, at);
    expect(first.claimed).toBe(true);
    const second = store.claim(id, at);
    expect(second).toEqual({ claimed: false, reason: 'duplicate' });
    expect(store.listRuns(id)).toHaveLength(1);
  });

  it('上一轮 running 未结束 → busy + 插入 skipped 行（并发可见）', () => {
    const id = makeTask();
    const at1 = Date.now();
    const first = store.claim(id, at1);
    expect(first.claimed).toBe(true);
    const runId = first.claimed ? first.run.id : 0;
    expect(store.startRun(runId)).toBe(true);

    const second = store.claim(id, at1 + 60_000);
    expect(second).toEqual({ claimed: false, reason: 'busy' });
    const runs = store.listRuns(id);
    expect(runs).toHaveLength(2);
    const skipped = runs.find((r) => r.status === 'skipped');
    expect(skipped).toBeDefined();
    expect(skipped?.error).toMatch(/并发防护/);
  });

  it('claimManual：与既有计划撞点时顺延 1ms 保证唯一', () => {
    const id = makeTask();
    const now = Date.now();
    expect(store.claim(id, now).claimed).toBe(true); // 计划触发先占了这一毫秒
    const manual = store.claimManual(id, now);
    expect(manual.claimed).toBe(true);
    if (manual.claimed) {
      expect(manual.run.manual).toBe(true);
      expect(manual.run.scheduledFor).toBe(now + 1);
    }
  });

  it('claimManual 遇 running → busy（不再顺延）', () => {
    const id = makeTask();
    const now = Date.now();
    const first = store.claim(id, now);
    if (first.claimed) store.startRun(first.run.id);
    expect(store.claimManual(id, now)).toEqual({ claimed: false, reason: 'busy' });
  });
});

describe('运行生命周期（状态迁移守卫）', () => {
  function runningRun(): { id: number; taskId: string } {
    const taskId = makeTask();
    const outcome = store.claim(taskId, Date.now());
    if (!outcome.claimed) throw new Error('claim 应成功');
    expect(store.startRun(outcome.run.id)).toBe(true);
    return { id: outcome.run.id, taskId };
  }

  it('pending → running → success；finishRun 只兑现一次', () => {
    const { id } = runningRun();
    expect(store.startRun(id)).toBe(false); // 已是 running，不能重复 start
    expect(store.finishRun(id, { status: 'success', output: '完成' })).toBe(true);
    expect(store.finishRun(id, { status: 'failed', error: '迟到的覆盖' })).toBe(false);

    const run = store.listRuns('nonexistent').length; // sanity：listRuns 不抛
    expect(run).toBe(0);
  });

  it('执行中退出：recoverInterruptedRuns 把 running 收敛为 interrupted，迟到完成不覆盖', () => {
    const { id, taskId } = runningRun();
    expect(store.recoverInterruptedRuns('应用退出导致运行中断')).toBe(1);
    expect(store.finishRun(id, { status: 'success', output: '迟到' })).toBe(false);
    const runs = store.listRuns(taskId);
    expect(runs[0].status).toBe('interrupted');
    expect(runs[0].error).toMatch(/退出/);
    expect(runs[0].finishedAt).not.toBeNull();
    expect(store.recoverInterruptedRuns('再次恢复')).toBe(0); // 幂等：没有 running 可收敛
  });

  it('失败重试：retryRun 回 pending 且 attempt+1；到期待执行含重试', () => {
    const { id, taskId } = runningRun();
    const nextRetry = Date.now() + 30_000;
    expect(store.retryRun(id, nextRetry)).toBe(true);
    expect(store.duePendingRuns(Date.now())).toHaveLength(0); // 重试未到点
    expect(store.duePendingRuns(nextRetry)).toHaveLength(1);

    expect(store.startRun(id)).toBe(true);
    expect(store.finishRun(id, { status: 'failed', error: 'LLM 超时' })).toBe(true);
    const runs = store.listRuns(taskId);
    expect(runs[0].attempt).toBe(1);
    expect(runs[0].error).toBe('LLM 超时');
  });

  it('markRunMissed 只作用于 pending；重复标记不改已终态行', () => {
    const taskId = makeTask();
    const outcome = store.claim(taskId, Date.now());
    if (!outcome.claimed) throw new Error('claim 应成功');
    expect(store.markRunMissed(outcome.run.id, '停机期间错过（catchup 关闭）')).toBe(true);
    expect(store.markRunMissed(outcome.run.id, 'again')).toBe(false);
    expect(store.listRuns(taskId)[0].status).toBe('missed');
  });

  it('insertMissed 幂等（OR IGNORE）', () => {
    const taskId = makeTask();
    const at = Date.now();
    store.insertMissed(taskId, at, at, '错过');
    store.insertMissed(taskId, at, at, '错过');
    expect(store.listRuns(taskId)).toHaveLength(1);
    expect(store.listRuns(taskId)[0].status).toBe('missed');
  });
});

describe('调度查询与失败策略', () => {
  it('dueTasks：仅 active 且到期；暂停任务不出现', () => {
    const id = makeTask({ schedule: '* * * * *' });
    const future = store.getTask(id)!.nextRunAt!;
    expect(store.dueTasks(future - 1)).toHaveLength(0);
    expect(store.dueTasks(future)).toHaveLength(1);
    store.setTaskEnabled(id, false);
    expect(store.dueTasks(Date.now() + 86_400_000)).toHaveLength(0);
  });

  it('recordFailure：达 failure_limit → 自动暂停 + 原因；recordSuccess 清零', () => {
    const id = makeTask({ failureLimit: 3 });
    expect(store.recordFailure(id, '连续失败 3 次，已暂停')).toEqual({
      consecutiveFailures: 1,
      paused: false
    });
    expect(store.recordFailure(id, 'x')).toEqual({ consecutiveFailures: 2, paused: false });
    const third = store.recordFailure(id, '连续失败 3 次，已暂停');
    expect(third.paused).toBe(true);
    const task = store.getTask(id)!;
    expect(task.status).toBe('paused');
    expect(task.pauseReason).toMatch(/连续失败/);

    // 恢复后再成功 → 计数清零
    store.setTaskEnabled(id, true);
    store.recordSuccess(id);
    expect(store.getTask(id)!.consecutiveFailures).toBe(0);
  });

  it('lastRun 返回最近一次（按计划时刻倒序）', () => {
    const taskId = makeTask();
    expect(store.lastRun(taskId)).toBeNull();
    const base = Date.now();
    store.claim(taskId, base - 1000);
    const second = store.claim(taskId, base);
    if (!second.claimed) throw new Error('claim 应成功');
    store.startRun(second.run.id);
    store.finishRun(second.run.id, { status: 'success', output: 'ok' });
    const runs = store.listRuns(taskId);
    expect(runs[0].output).toBe('ok');
    expect(store.lastRun(taskId)?.scheduledFor).toBe(base);
  });
});
