/**
 * 阶段 8：Skill 执行器契约单测（真实 spawn 子进程，覆盖成功/超时/取消/失败路径）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SKILL_MAX_OUTPUT_CHARS, runSkillTool } from './executor';
import type { SkillRunOptions } from './executor';

const cleanups: string[] = [];

/** 写一个脚本文件，返回绝对路径 */
function writeScript(code: string): { entryPath: string; skillDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fairy-skill-exec-'));
  cleanups.push(dir);
  const entryPath = join(dir, 'tool.js');
  writeFileSync(entryPath, code, 'utf8');
  return { entryPath, skillDir: dir };
}

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 忽略清理失败 */
    }
  }
});

/** 基线选项：node 直跑（vitest 下 process.execPath = node）；workspace 统一登记清理 */
function baseOptions(over: Partial<SkillRunOptions> & Pick<SkillRunOptions, 'entryPath' | 'skillDir'>): SkillRunOptions {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'fairy-skill-ws-'));
  cleanups.push(workspaceRoot);
  return {
    runtimeExec: process.execPath,
    workspaceRoot,
    toolName: 'demo_tool',
    input: { a: 1 },
    timeoutMs: 10_000,
    ...over
  };
}

/** 标准 echo 脚本：stdin 读请求 → stdout 回 JSON */
const ECHO_SCRIPT = `
let d = '';
process.stdin.on('data', (c) => (d += c));
process.stdin.on('end', () => {
  const req = JSON.parse(d);
  process.stdout.write(JSON.stringify({ tool: req.tool, input: req.input }));
});
`;

describe('runSkillTool（执行契约）', () => {
  it('成功路径：stdin 收到 {tool,input}，stdout JSON 作为结果返回', async () => {
    const { entryPath, skillDir } = writeScript(ECHO_SCRIPT);
    const opts = baseOptions({ entryPath, skillDir });
    const result = await runSkillTool(opts);
    expect(result).toEqual({ tool: 'demo_tool', input: { a: 1 } });
  });

  it('FAIRY_SKILL_DIR / FAIRY_WORKSPACE_DIR / FAIRY_TOOL_NAME 注入可见', async () => {
    const { entryPath, skillDir } = writeScript(`
      process.stdout.write(JSON.stringify({
        skillDir: process.env.FAIRY_SKILL_DIR,
        ws: process.env.FAIRY_WORKSPACE_DIR,
        tool: process.env.FAIRY_TOOL_NAME,
        key: process.env.SECRET_LEAK ?? 'absent'
      }));
    `);
    const opts = baseOptions({ entryPath, skillDir });
    const result = (await runSkillTool(opts)) as Record<string, string>;
    expect(result.skillDir).toBe(skillDir);
    expect(result.ws).toBe(opts.workspaceRoot);
    expect(result.tool).toBe('demo_tool');
    expect(result.key).toBe('absent'); // 最小 env：不继承宿主变量
  });

  it('退出码非 0 → 抛错且带 stderr 尾部', async () => {
    const { entryPath, skillDir } = writeScript(`
      process.stderr.write('boom-detail');
      process.exit(3);
    `);
    await expect(runSkillTool(baseOptions({ entryPath, skillDir }))).rejects.toThrow(/退出码 3.*boom-detail/);
  });

  it('stdout 非 JSON → 抛错（调试输出必须走 stderr）', async () => {
    const { entryPath, skillDir } = writeScript(`
      console.log('debug line');
      console.log(JSON.stringify({ ok: true }));
    `);
    await expect(runSkillTool(baseOptions({ entryPath, skillDir }))).rejects.toThrow(/不是合法 JSON/);
  });

  it('stdout 为空 → 抛错并提示契约', async () => {
    const { entryPath, skillDir } = writeScript(`process.exit(0);`);
    await expect(runSkillTool(baseOptions({ entryPath, skillDir }))).rejects.toThrow(/无输出/);
  });

  it('超时 → kill 并抛超时错误', async () => {
    const { entryPath, skillDir } = writeScript(`
      setTimeout(() => process.stdout.write('{}'), 60_000);
    `);
    const started = Date.now();
    await expect(runSkillTool(baseOptions({ entryPath, skillDir, timeoutMs: 700 }))).rejects.toThrow(/超时/);
    expect(Date.now() - started).toBeLessThan(15_000); // 不等满 60s
  });

  it('AbortSignal 取消 → 立即拒绝（AbortError 语义）', async () => {
    const { entryPath, skillDir } = writeScript(`
      setTimeout(() => process.stdout.write('{}'), 60_000);
    `);
    const controller = new AbortController();
    const promise = runSkillTool(baseOptions({ entryPath, skillDir, signal: controller.signal }));
    setTimeout(() => controller.abort(new DOMException('Aborted', 'AbortError')), 150);
    await expect(promise).rejects.toThrow(/Abort/);
  });

  it('超大输出 → 截断并结束进程', async () => {
    const { entryPath, skillDir } = writeScript(`
      const chunk = 'x'.repeat(50_000);
      process.stdout.write(chunk);
      process.stdout.write(chunk);
      process.stdout.write(chunk);
      process.stdout.write(chunk);
      setTimeout(() => process.stdout.write('{}'), 30_000);
    `);
    await expect(runSkillTool(baseOptions({ entryPath, skillDir }))).rejects.toThrow(
      new RegExp(`${SKILL_MAX_OUTPUT_CHARS}`)
    );
  });

  it('运行时可执行文件不存在 → spawn 错误可见', async () => {
    const { entryPath, skillDir } = writeScript(`// never runs`);
    await expect(
      runSkillTool(baseOptions({ entryPath, skillDir, runtimeExec: 'fairy-no-such-runtime.exe' }))
    ).rejects.toThrow();
  });
});
