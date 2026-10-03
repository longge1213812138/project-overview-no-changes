import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createWorkspaceFilesTool,
  type WorkspaceFilesListResult,
  type WorkspaceFilesReadResult
} from './workspace-files';

let ws = '';
const reg = () => createWorkspaceFilesTool(ws);

beforeAll(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'fairy-wf-'));
  fs.writeFileSync(path.join(ws, 'hello.txt'), '你好，Fairy！');
  fs.writeFileSync(path.join(ws, 'blob.bin'), Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47]));
  fs.writeFileSync(path.join(ws, 'big.txt'), 'x'.repeat(200_000));
  fs.mkdirSync(path.join(ws, 'sub'));
  // 截断用例：501 个条目触发 500 上限
  const many = path.join(ws, 'many');
  fs.mkdirSync(many);
  for (let i = 0; i <= 500; i++) {
    fs.writeFileSync(path.join(many, `f-${i}.txt`), '');
  }
});

afterAll(() => {
  if (ws) fs.rmSync(ws, { recursive: true, force: true });
});

describe('workspace_files', () => {
  it('注册元数据：approval=auto、risk=read、source=builtin', () => {
    const tool = reg();
    expect(tool.tool.definition.function.name).toBe('workspace_files');
    expect(tool.approval).toBe('auto');
    expect(tool.risk).toBe('read');
    expect(tool.source).toBe('builtin');
    expect(tool.assess).toBeTypeOf('function');
  });

  it('validateInput：严格 schema（op 枚举、path 字符串、未知键拒绝）', () => {
    const validate = reg().tool.validateInput;
    expect(validate({ op: 'list' })).toBe(true);
    expect(validate({ op: 'read', path: 'a.txt' })).toBe(true);
    expect(validate({})).toBe(false);
    expect(validate({ op: 'cat' })).toBe(false);
    expect(validate({ op: 'read', path: 42 })).toBe(false);
    expect(validate({ op: 'list', extra: 1 })).toBe(false);
    expect(validate('list')).toBe(false);
    expect(validate(null)).toBe(false);
  });

  it('list：列出目录条目（类型/大小/修改时间）', async () => {
    const out = (await reg().tool.execute({ op: 'list' }, {})) as WorkspaceFilesListResult;
    expect(out.truncated).toBe(false);
    const byName = new Map(out.entries.map((entry) => [entry.name, entry]));
    expect(byName.get('hello.txt')?.type).toBe('file');
    expect(byName.get('hello.txt')?.size).toBe(Buffer.byteLength('你好，Fairy！'));
    expect(typeof byName.get('hello.txt')?.mtimeMs).toBe('number');
    expect(byName.get('sub')?.type).toBe('dir');
    expect(byName.get('blob.bin')?.type).toBe('file');
  });

  it('list：超过 500 条截断并标记', async () => {
    const out = (await reg().tool.execute(
      { op: 'list', path: 'many' },
      {}
    )) as WorkspaceFilesListResult;
    expect(out.entries).toHaveLength(500);
    expect(out.truncated).toBe(true);
  });

  it('read：正常文本返回内容且不截断', async () => {
    const out = (await reg().tool.execute(
      { op: 'read', path: 'hello.txt' },
      {}
    )) as WorkspaceFilesReadResult;
    expect(out.binary).toBe(false);
    expect(out.content).toBe('你好，Fairy！');
    expect(out.truncated).toBe(false);
    expect(out.size).toBe(Buffer.byteLength('你好，Fairy！'));
  });

  it('read：前 8KB 含空字节判定为二进制，不回传正文', async () => {
    const out = (await reg().tool.execute(
      { op: 'read', path: 'blob.bin' },
      {}
    )) as WorkspaceFilesReadResult;
    expect(out.binary).toBe(true);
    expect(out.note).toBeTruthy();
    expect(out.content).toBeUndefined();
  });

  it('read：超过 128KB 只读前 128KB 并标记截断', async () => {
    const out = (await reg().tool.execute(
      { op: 'read', path: 'big.txt' },
      {}
    )) as WorkspaceFilesReadResult;
    expect(out.binary).toBe(false);
    expect(out.truncated).toBe(true);
    expect(out.content).toHaveLength(128 * 1024);
    expect(out.size).toBe(200_000);
  });

  it('read：目录不是普通文件则拒绝', async () => {
    await expect(
      reg().tool.execute({ op: 'read', path: 'sub' }, {})
    ).rejects.toThrow('不是普通文件');
  });

  it('assess：工作区内路径 → allow', () => {
    expect(reg().assess?.({ op: 'list' })?.decision).toBe('allow');
    expect(reg().assess?.({ op: 'read', path: 'hello.txt' })?.decision).toBe('allow');
  });

  it('assess：越界路径 → ask + outside + 可读原因', () => {
    const assessment = reg().assess?.({ op: 'read', path: '../../escape.txt' });
    expect(assessment?.decision).toBe('ask');
    expect(assessment?.outside).toBe(true);
    expect(assessment?.reason).toContain('将访问工作区外路径：');
  });

  it('execute：未获越界确认 → 抛错拒绝', async () => {
    await expect(
      reg().tool.execute({ op: 'read', path: '../../escape.txt' }, {})
    ).rejects.toThrow('越界访问未获用户确认');
  });

  it('assess：path 含展开语法（%）→ deny（安全层拦截，schema 层不拦）', () => {
    const input = { op: 'read', path: '%TEMP%/x.txt' };
    expect(reg().tool.validateInput(input)).toBe(true);
    expect(reg().assess?.(input)?.decision).toBe('deny');
    expect(reg().assess?.(input)?.reason).toBeTruthy();
  });

  it('execute：signal 已取消 → 抛 AbortError', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      reg().tool.execute({ op: 'list' }, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
