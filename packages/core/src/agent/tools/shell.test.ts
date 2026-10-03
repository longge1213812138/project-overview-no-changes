import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ALLOWED_COMMANDS,
  buildMinimalEnv,
  createShellTool,
  DENY_COMMANDS,
  type ShellResult
} from './shell';

const isWin = process.platform === 'win32';
const B = String.fromCharCode(92); // 反斜杠

let ws = '';
// 等价于 ..\..\x.txt 的越界参数
const escapeArg = ['..', '..', 'x.txt'].join(B);

beforeAll(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'fairy-sh-'));
});

afterAll(() => {
  if (ws) fs.rmSync(ws, { recursive: true, force: true });
});

describe('shell 名单', () => {
  it('白名单与拒绝名单互不重叠，且解释器均在拒绝名单', () => {
    for (const name of ['cmd', 'powershell', 'pwsh', 'mshta', 'certutil', 'reg']) {
      expect(DENY_COMMANDS).toContain(name);
      expect(ALLOWED_COMMANDS).not.toContain(name);
    }
    for (const name of ALLOWED_COMMANDS) {
      expect(DENY_COMMANDS).not.toContain(name);
    }
  });
});

describe('shell assess', () => {
  const tool = () => createShellTool(ws);

  it('powershell / cmd（含 .exe 后缀）→ deny：安全策略禁止', () => {
    const powershell = tool().assess?.({ command: 'powershell' });
    expect(powershell?.decision).toBe('deny');
    expect(powershell?.reason).toBe('该命令被安全策略禁止');
    expect(tool().assess?.({ command: 'cmd' })?.decision).toBe('deny');
    expect(tool().assess?.({ command: 'cmd.exe' })?.decision).toBe('deny');
    expect(tool().assess?.({ command: 'CMD.EXE' })?.decision).toBe('deny');
  });

  it('带路径的命令 → deny：必须是纯可执行名', () => {
    const assessment = tool().assess?.({ command: `C:${B}x` });
    expect(assessment?.decision).toBe('deny');
    expect(assessment?.reason).toBe('命令必须是白名单内的可执行名，不含路径');
    expect(tool().assess?.({ command: './whoami' })?.decision).toBe('deny');
    expect(tool().assess?.({ command: 'C:whoami' })?.decision).toBe('deny');
  });

  it('未知命令 → deny：无法证明安全的命令拒绝执行', () => {
    const assessment = tool().assess?.({ command: 'curl' });
    expect(assessment?.decision).toBe('deny');
    expect(assessment?.reason).toContain('命令不在白名单内：curl');
    expect(assessment?.reason).toContain('无法证明安全的命令拒绝执行');
  });

  it('"findstr foo ..\\..\\x.txt" → ask + outside（合并为一次带越界警告的审批）', () => {
    const assessment = tool().assess?.({ command: 'findstr', args: ['foo', escapeArg] });
    expect(assessment?.decision).toBe('ask');
    expect(assessment?.outside).toBe(true);
    expect(assessment?.reason).toContain('命令参数触及工作区外路径：');
    expect(assessment?.reason).toContain('x.txt');
  });

  it('合法白名单命令 → allow（大小写不敏感、允许 .exe 后缀）', () => {
    expect(tool().assess?.({ command: 'whoami' })).toEqual({ decision: 'allow' });
    expect(tool().assess?.({ command: 'WHOAMI' })).toEqual({ decision: 'allow' });
    expect(tool().assess?.({ command: 'Whoami.exe' })).toEqual({ decision: 'allow' });
    // 旗标参数（如 /i、/f）被解析为工作区内路径，不触发越界
    expect(tool().assess?.({ command: 'tree', args: ['/f'] })).toEqual({ decision: 'allow' });
  });

  it('结构不合法 → deny', () => {
    expect(tool().assess?.('whoami')?.decision).toBe('deny');
    expect(tool().assess?.({ command: '' })?.decision).toBe('deny');
    expect(tool().assess?.({ command: 'whoami', args: 'x' })?.decision).toBe('deny');
    expect(tool().assess?.({ command: 'whoami', args: ['x'.repeat(2049)] })?.decision).toBe(
      'deny'
    );
    expect(tool().assess?.({ command: 'whoami', args: new Array(33).fill('x') })?.decision).toBe(
      'deny'
    );
    expect(tool().assess?.({ command: 'whoami', extra: 1 })?.decision).toBe('deny');
  });
});

describe('shell validateInput', () => {
  const validate = createShellTool(ws).tool.validateInput;

  it('对象、命令非空、参数每项受限、未知键拒绝', () => {
    expect(validate({ command: 'whoami' })).toBe(true);
    expect(validate({ command: 'findstr', args: ['/i', 'foo'] })).toBe(true);
    expect(validate({ command: 'whoami', args: [] })).toBe(true);
    expect(validate({})).toBe(false);
    expect(validate({ command: '' })).toBe(false);
    expect(validate({ command: 42 })).toBe(false);
    expect(validate({ command: 'whoami', args: [1] })).toBe(false);
    expect(validate({ command: 'whoami', args: 'foo' })).toBe(false);
    expect(validate({ command: 'whoami', args: ['x'.repeat(2049)] })).toBe(false);
    expect(validate({ command: 'whoami', args: new Array(33).fill('x') })).toBe(false);
    expect(validate({ command: 'whoami', extra: 1 })).toBe(false);
    expect(validate(null)).toBe(false);
  });
});

describe('shell execute', () => {
  const tool = () => createShellTool(ws);

  it('未确认越界（allowOutside 缺省）→ 拒绝执行', async () => {
    await expect(
      tool().tool.execute({ command: 'findstr', args: ['foo', escapeArg] }, {})
    ).rejects.toThrow('越界操作未获用户确认');
  });

  it.skipIf(!isWin)('真实 spawn 白名单命令：whoami 成功返回 code 0 且 stdout 非空', async () => {
    const out = (await tool().tool.execute({ command: 'whoami' }, {})) as ShellResult;
    expect(out.code).toBe(0);
    expect(out.stdout.length).toBeGreaterThan(0);
    expect(out.truncated).toBe(false);
    expect(out.command).toBe('whoami');
    expect(out.args).toEqual([]);
    expect(out.stderr).toBeTypeOf('string');
  });

  it.skipIf(!isWin)('spawn systeminfo 后 abort → 以 AbortError 拒绝', async () => {
    const controller = new AbortController();
    const promise = tool().tool.execute({ command: 'systeminfo' }, {
      signal: controller.signal
    });
    setTimeout(() => controller.abort(), 60);
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  }, 10_000);
});

describe('buildMinimalEnv', () => {
  it('只保留白名单环境变量，不泄漏调用方自定义变量', () => {
    const systemRoot = `C:${B}Windows`;
    const input: NodeJS.ProcessEnv = {
      SystemRoot: systemRoot,
      windir: systemRoot,
      TEMP: `${systemRoot}${B}Temp`,
      TMP: `${systemRoot}${B}Temp`,
      PATH: `C:${B}evil`,
      MY_CUSTOM: 'secret',
      APPDATA: 'leak',
      SECRET_TOKEN: 'leak'
    };
    const snapshot = { ...input };
    const minimal = buildMinimalEnv(input);

    expect(minimal.PATH).toBe(`${systemRoot}${B}System32`);
    expect(minimal.SystemRoot).toBe(systemRoot);
    expect(minimal.windir).toBe(systemRoot);
    expect(minimal.TEMP).toBe(input.TEMP);
    expect(minimal.TMP).toBe(input.TMP);
    expect(minimal).not.toHaveProperty('MY_CUSTOM');
    expect(minimal).not.toHaveProperty('APPDATA');
    expect(minimal).not.toHaveProperty('SECRET_TOKEN');
    expect(Object.keys(minimal).every((key) =>
      ['SystemRoot', 'windir', 'PATH', 'TEMP', 'TMP'].includes(key)
    )).toBe(true);
    // 纯函数：入参不被修改
    expect(input).toEqual(snapshot);
  });

  it('缺少 SystemRoot 时不产出 PATH', () => {
    const minimal = buildMinimalEnv({ FOO: 'bar' });
    expect(minimal).toEqual({});
  });
});
