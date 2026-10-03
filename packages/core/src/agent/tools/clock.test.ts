import { describe, expect, it } from 'vitest';
import { createClockTool, type ClockResult } from './clock';

const tool = createClockTool();

describe('get_current_time', () => {
  it('注册元数据：approval=ask（每次都弹审批）、risk=read、source=builtin', () => {
    expect(tool.tool.definition.function.name).toBe('get_current_time');
    expect(tool.tool.definition.function.description).toBe('获取当前日期时间');
    expect(tool.approval).toBe('ask');
    expect(tool.risk).toBe('read');
    expect(tool.source).toBe('builtin');
  });

  it('缺省时区：用本机时区返回 iso/epochMs/resolved', async () => {
    const before = Date.now();
    const out = (await tool.tool.execute({}, {})) as ClockResult;
    expect(Number.isNaN(Date.parse(out.iso))).toBe(false);
    expect(out.iso.endsWith('Z')).toBe(true);
    expect(out.epochMs).toBeGreaterThanOrEqual(before);
    expect(out.epochMs).toBeLessThanOrEqual(Date.now() + 1000);
    expect(out.timezone).toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(out.resolved.length).toBeGreaterThan(0);
  });

  it('合法 timezone：被采纳并用于格式化', async () => {
    const out = (await tool.tool.execute({ timezone: 'Asia/Shanghai' }, {})) as ClockResult;
    expect(out.timezone).toBe('Asia/Shanghai');
    expect(out.resolved.length).toBeGreaterThan(0);
  });

  it('非法 timezone：validateInput 不通过', () => {
    expect(tool.tool.validateInput({ timezone: 'Not/AZone' })).toBe(false);
    expect(tool.tool.validateInput({ timezone: '' })).toBe(false);
    expect(tool.tool.validateInput({ timezone: 42 })).toBe(false);
  });

  it('validateInput：结构校验（对象、未知键拒绝、timezone 可选）', () => {
    expect(tool.tool.validateInput({})).toBe(true);
    expect(tool.tool.validateInput({ timezone: 'UTC' })).toBe(true);
    expect(tool.tool.validateInput({ timezone: 'UTC', extra: 1 })).toBe(false);
    expect(tool.tool.validateInput('now')).toBe(false);
    expect(tool.tool.validateInput(null)).toBe(false);
    expect(tool.tool.validateInput([])).toBe(false);
  });

  it('signal 已取消：抛 AbortError', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      tool.tool.execute({}, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
