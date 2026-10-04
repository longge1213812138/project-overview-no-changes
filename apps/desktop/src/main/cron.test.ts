/**
 * 阶段 9：cron 驱动（main）恢复语义测试（DEV_PLAN 阶段 9 验收：
 * 重启恢复且避免重复执行、执行中退出、错过触发按 catchup 语义、通道门控暂停+通知）。
 *
 * mock 面：electron（app.getPath → 每次独立临时目录 / Notification 记录）、
 * channel（通道不可用，验证门控）、agent-tools（注册表未用到）、windows/logger（vi.fn）。
 * 纯调度语义（时区/DST/幂等 claim/失败策略）在 @fairy/core 的 cron 单测里钉死，这里只测编排。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@fairy/core'
import type { CronRun } from '@fairy/core'

vi.mock('./logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('./windows', () => ({
  broadcast: vi.fn(),
  showMainWindow: vi.fn()
}))

vi.mock('./channel', () => ({
  resolveActiveChannel: vi.fn(() => ({ ok: false, error: '通道不可用（测试桩）' }))
}))

vi.mock('./agent-tools', () => ({
  getToolRegistry: vi.fn(() => {
    throw new Error('注册表未初始化（测试桩）')
  }),
  probeToolsSupportCached: vi.fn()
}))

vi.mock('electron', async () => {
  const { mkdtempSync: mk } = await import('node:fs')
  const { tmpdir: tmp } = await import('node:os')
  const { join: j } = await import('node:path')
  const dirs: string[] = []
  class NotificationStub {
    title: string
    body: string
    static sent: Array<{ title: string; body: string }> = []
    constructor(opts: { title: string; body: string }) {
      this.title = opts.title
      this.body = opts.body
    }
    on(): this {
      return this
    }
    show(): void {
      NotificationStub.sent.push({ title: this.title, body: this.body })
    }
  }
  return {
    // 每次调用新临时目录：不同测试模块实例（resetModules）拿到独立 fairy.db
    app: { getPath: (): string => {
      const dir = mk(j(tmp(), 'fairy-cron-driver-'))
      dirs.push(dir)
      return dir
    } },
    Notification: NotificationStub,
    __dirs: dirs
  }
})

type CronModule = typeof import('./cron')

const activeModules: CronModule[] = []

async function loadCron(): Promise<CronModule> {
  vi.resetModules()
  const mod = await import('./cron')
  activeModules.push(mod)
  return mod
}

/** 轮询等待断言条件成立（驱动是异步串行队列） */
async function waitFor(probe: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (probe()) return
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function runTerminal(run: CronRun): boolean {
  return !['pending', 'running'].includes(run.status)
}

afterEach(async () => {
  for (const mod of activeModules.splice(0)) {
    mod.shutdownCron()
  }
  vi.clearAllMocks()
  const electron = (await import('electron')) as unknown as { __dirs?: string[] }
  const { rmSync } = await import('node:fs')
  for (const dir of electron.__dirs ?? []) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 句柄释放延迟时忽略清理失败
    }
  }
  vi.resetModules()
})

describe('cron 驱动：启动恢复', () => {
  it('catchup=true → 合并补跑最近一次错过（只执行一轮）；通道不可用 → 暂停 + 通知', async () => {
    const cron = await loadCron()
    const store = cron.getCronStore()
    const task = store.createTask({
      name: '晨间整理',
      prompt: 'p',
      schedule: '* * * * *',
      timezone: 'UTC'
    })
    // 模拟停机 5 分钟（错过 5 次触发）
    store.advance(task.id, Date.now() - 5 * 60_000, null)

    cron.initCron()
    // 恢复 → claim → 串行执行 → 通道门控失败收敛
    await waitFor(() => store.listRuns(task.id).some(runTerminal))

    const runs = store.listRuns(task.id)
    expect(runs).toHaveLength(1); // 合并：5 次错过只补跑 1 次（幂等键 = 最近一次）
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error).toContain('通道不可用');
    expect(runs[0].startedAt).not.toBeNull(); // 真的走到了执行（非静默吞掉）

    const paused = store.getTask(task.id)!;
    expect(paused.status).toBe('paused');
    expect(paused.pauseReason).toContain('通道不可用');

    // next_run_at 已推进到未来（不会在同一窗口反复触发）
    expect(paused.nextRunAt).toBeGreaterThan(Date.now());

    // 暂停通知已弹出且标题带任务名
    const electron = (await import('electron')) as unknown as {
      Notification: { sent: Array<{ title: string; body: string }> }
    };
    expect(electron.Notification.sent.some((n) => n.title.includes('晨间整理'))).toBe(true);
  });

  it('catchup=false → 记 missed 不补跑（不产生执行）', async () => {
    const cron = await loadCron();
    const store = cron.getCronStore();
    const task = store.createTask({
      name: '不补跑任务',
      prompt: 'p',
      schedule: '* * * * *',
      timezone: 'UTC',
      catchup: false
    });
    store.advance(task.id, Date.now() - 3 * 60_000, null);

    cron.initCron();
    await waitFor(() => store.listRuns(task.id).length > 0);
    // 给驱动一个执行机会（若误入队会被执行成 failed）
    await new Promise((resolve) => setTimeout(resolve, 200));

    const runs = store.listRuns(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('missed'); // 不是 failed/成功 → 确实没执行
    expect(store.getTask(task.id)!.status).toBe('active'); // 未暂停（没有执行失败）
  });

  it('执行中退出的遗留 running → interrupted（不伪装成成功/失败）', async () => {
    const cron = await loadCron();
    const store = cron.getCronStore();
    const task = store.createTask({ name: '崩溃任务', prompt: 'p', schedule: '0 9 * * *', timezone: 'UTC' });
    // 手工制造「已 claim 且 running」的崩溃现场
    const outcome = store.claim(task.id, Date.now() - 60_000);
    if (!outcome.claimed) throw new Error('claim 应成功');
    expect(store.startRun(outcome.run.id)).toBe(true);

    cron.initCron();
    await waitFor(() => {
      const run = store.getRun(outcome.run.id);
      return run !== null && run.status === 'interrupted';
    });
    const run = store.getRun(outcome.run.id)!;
    expect(run.error).toContain('退出');
    expect(run.finishedAt).not.toBeNull();

    // 任务本身 next_run_at 在未来（09:00 表达式），恢复不应补 claim
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(store.listRuns(task.id)).toHaveLength(1);
  });

  it('重复 initCron 幂等（第二次不再恢复/不重复执行）', async () => {
    const cron = await loadCron();
    const store = cron.getCronStore();
    const task = store.createTask({ name: '幂等任务', prompt: 'p', schedule: '* * * * *', timezone: 'UTC' });
    store.advance(task.id, Date.now() - 60_000, null);

    cron.initCron();
    cron.initCron(); // 幂等：initialized 短路
    await waitFor(() => store.listRuns(task.id).some(runTerminal));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(store.listRuns(task.id)).toHaveLength(1);
  });
});

describe('cron 驱动：IPC 面与手动触发', () => {
  it('listCron 返回任务 + 工具选项；trigger 走同一门控（通道不可用 → 失败并暂停）', async () => {
    const cron = await loadCron();
    const store = cron.getCronStore();
    const task = store.createTask({
      name: '手动任务',
      prompt: 'p',
      schedule: '0 9 * * *',
      timezone: 'Asia/Shanghai',
      preauthorized: ['get_current_time']
    });

    const list = cron.listCron();
    expect(list.tasks.map((t) => t.id)).toContain(task.id);
    expect(list.tools).toEqual([]); // 注册表桩抛错 → 空工具列表（不崩）

    const triggered = cron.triggerCronTask(task.id);
    expect(triggered.ok).toBe(true);
    await waitFor(() => store.listRuns(task.id).some(runTerminal));

    const runs = store.listRuns(task.id);
    expect(runs[0].manual).toBe(true);
    expect(runs[0].status).toBe('failed'); // 通道门控
    expect(store.getTask(task.id)!.status).toBe('paused');

    // 暂停后手动触发直接拒绝（不绕过门控、不产生新运行）
    const again = cron.triggerCronTask(task.id);
    expect(again.ok).toBe(false);
    expect(again.error).toContain('暂停');
    expect(store.listRuns(task.id)).toHaveLength(1);
  });

  it('create/update/remove 错误路径可见（坏表达式返回 ok:false）', async () => {
    const cron = await loadCron();
    const bad = cron.createCronTask({ name: 'x', prompt: 'y', schedule: 'not a cron' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toBeTruthy();

    const good = cron.createCronTask({ name: '正常任务', prompt: 'y', schedule: '0 9 * * *' });
    expect(good.ok).toBe(true);
    const id = good.task!.id;

    const patched = cron.updateCronTask(id, { schedule: '*/10 * * * *' });
    expect(patched.ok).toBe(true);
    expect(patched.task!.schedule).toBe('*/10 * * * *');

    cron.removeCronTask(id);
    expect(cron.listCron().tasks.map((t) => t.id)).not.toContain(id);
    expect(() => cron.removeCronTask(id)).toThrow(/不存在/);
  });

  it('广播 cronChanged（面板刷新依赖）', async () => {
    const cron = await loadCron();
    const { broadcast } = await import('./windows');
    cron.createCronTask({ name: '广播任务', prompt: 'y', schedule: '0 9 * * *' });
    expect(vi.mocked(broadcast).mock.calls.some(([ch]) => ch === IPC.cronChanged)).toBe(true);
  });
});
