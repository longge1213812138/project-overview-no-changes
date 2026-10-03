import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../registry';
import { createBuiltinTools } from './index';

const tools = createBuiltinTools({ workspaceRoot: 'C:\\fairy-ws' });

describe('createBuiltinTools', () => {
  it('返回三个内置工具，顺序与时钟/文件/壳约定一致', () => {
    expect(tools.map((reg) => reg.tool.definition.function.name)).toEqual([
      'get_current_time',
      'workspace_files',
      'shell'
    ]);
    expect(tools.every((reg) => reg.source === 'builtin')).toBe(true);
  });

  it('可直接登记进 ToolRegistry（工具名与 schema 合规）', () => {
    const registry = new ToolRegistry();
    for (const reg of tools) {
      registry.register(reg);
    }
    expect(registry.list()).toHaveLength(3);
    expect(registry.definitions().map((def) => def.function.name)).toContain('shell');
  });

  it('风险与审批策略：时钟与 shell 每次 ask，文件 auto 且带策略钩子', () => {
    const byName = new Map(tools.map((reg) => [reg.tool.definition.function.name, reg]));
    expect(byName.get('get_current_time')?.approval).toBe('ask');
    expect(byName.get('get_current_time')?.risk).toBe('read');
    expect(byName.get('workspace_files')?.approval).toBe('auto');
    expect(byName.get('workspace_files')?.risk).toBe('read');
    expect(byName.get('workspace_files')?.assess).toBeTypeOf('function');
    expect(byName.get('shell')?.approval).toBe('ask');
    expect(byName.get('shell')?.risk).toBe('exec');
    expect(byName.get('shell')?.assess).toBeTypeOf('function');
  });

  it('三个工具均通过 validateInput 严格校验', () => {
    const byName = new Map(tools.map((reg) => [reg.tool.definition.function.name, reg]));
    expect(byName.get('get_current_time')?.tool.validateInput({})).toBe(true);
    expect(byName.get('get_current_time')?.tool.validateInput({ timezone: 1 })).toBe(false);
    expect(byName.get('workspace_files')?.tool.validateInput({ op: 'list' })).toBe(true);
    expect(byName.get('workspace_files')?.tool.validateInput({})).toBe(false);
    expect(byName.get('shell')?.tool.validateInput({ command: 'whoami' })).toBe(true);
    expect(byName.get('shell')?.tool.validateInput({ command: '' })).toBe(false);
  });
});
