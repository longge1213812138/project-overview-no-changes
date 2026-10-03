import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveWorkspacePath } from './pathguard';

const isWin = process.platform === 'win32';

// 测试工作区：临时目录做 workspaceRoot，避免污染仓库
let ws = '';
// 工作区外的对照目录（junction 指向它）
let outsideDir = '';
// junction 创建成功与否（失败则跳过该用例）
let junctionReady = false;

// 模块加载时立即建目录（it.skipIf 在收集期求值，早于 beforeAll）
ws = fs.mkdtempSync(path.join(os.tmpdir(), 'fairy-pg-'));
outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fairy-pg-out-'));
fs.mkdirSync(path.join(ws, 'sub'));
fs.writeFileSync(path.join(ws, 'sub', 'file.txt'), 'hello');
try {
  fs.symlinkSync(outsideDir, path.join(ws, 'esc'), 'junction');
  junctionReady = true;
} catch {
  // 创建失败（权限等）则跳过对应用例
  junctionReady = false;
}

afterAll(() => {
  if (ws) fs.rmSync(ws, { recursive: true, force: true });
  if (outsideDir) fs.rmSync(outsideDir, { recursive: true, force: true });
});

describe('resolveWorkspacePath', () => {
  it('工作区内相对路径：ok 且 outside=false，resolved 为真实绝对路径', () => {
    const check = resolveWorkspacePath(ws, 'sub/file.txt');
    expect(check.ok).toBe(true);
    expect(check.outside).toBe(false);
    expect(check.resolved?.toLowerCase()).toBe(
      path.join(fs.realpathSync(ws), 'sub', 'file.txt').toLowerCase()
    );
  });

  it('尚不存在的写入目标同样可解析（最长存在祖先 realpath + 尾部拼回）', () => {
    const check = resolveWorkspacePath(ws, 'sub/new-dir/new-file.txt');
    expect(check.ok).toBe(true);
    expect(check.outside).toBe(false);
    expect(check.resolved?.toLowerCase()).toBe(
      path.join(fs.realpathSync(ws), 'sub', 'new-dir', 'new-file.txt').toLowerCase()
    );
  });

  it('"..\\..\\escape" 逃逸：ok 且 outside=true', () => {
    const check = resolveWorkspacePath(ws, '..\\..\\escape');
    expect(check.ok).toBe(true);
    expect(check.outside).toBe(true);
    expect(check.resolved).toBeDefined();
  });

  it.skipIf(!isWin)('绝对路径 C:\\Windows 在工作区外：ok 且 outside=true', () => {
    const check = resolveWorkspacePath(ws, 'C:\\Windows');
    expect(check.ok).toBe(true);
    expect(check.outside).toBe(true);
  });

  it('UNC 路径：ok=false（不进审批直接拒绝）', () => {
    const check = resolveWorkspacePath(ws, '\\\\server\\share\\x.txt');
    expect(check.ok).toBe(false);
    expect(check.reason).toBeTruthy();
    // 正斜杠形式的 UNC 同样拒绝
    expect(resolveWorkspacePath(ws, '//server/share/x.txt').ok).toBe(false);
    // 设备路径同样拒绝
    expect(resolveWorkspacePath(ws, '\\\\.\\pipe\\evil').ok).toBe(false);
  });

  it('含展开语法（%TEMP% / ${HOME} / $HOME / 任意百分号）：ok=false', () => {
    expect(resolveWorkspacePath(ws, '%TEMP%/x.txt').ok).toBe(false);
    expect(resolveWorkspacePath(ws, '${HOME}/x.txt').ok).toBe(false);
    expect(resolveWorkspacePath(ws, '$HOME/x.txt').ok).toBe(false);
    expect(resolveWorkspacePath(ws, '50%off.txt').ok).toBe(false);
  });

  it.skipIf(!isWin)('盘符相对路径 C:foo 与扩展前缀：盘符相对拒绝、\\\\?\\ 剥前缀后继续判定', () => {
    expect(resolveWorkspacePath(ws, 'C:foo').ok).toBe(false);
    expect(resolveWorkspacePath(ws, 'C:').ok).toBe(false);
    const stripped = resolveWorkspacePath(ws, '\\\\?\\C:\\Windows');
    expect(stripped.ok).toBe(true);
    expect(stripped.outside).toBe(true);
  });

  it('空串与控制字符：ok=false', () => {
    expect(resolveWorkspacePath(ws, '').ok).toBe(false);
    expect(resolveWorkspacePath(ws, '   ').ok).toBe(false);
    expect(resolveWorkspacePath(ws, 'bad\u0000name').ok).toBe(false);
    expect(resolveWorkspacePath(ws, 'bad\nname').ok).toBe(false);
  });

  it.skipIf(!junctionReady)('junction 指向工作区外：realpath 解析后 outside=true', () => {
    const check = resolveWorkspacePath(ws, 'esc');
    expect(check.ok).toBe(true);
    expect(check.outside).toBe(true);
  });

  it.skipIf(!isWin)('大小写变体与分隔符归一：workspaceRoot 大写、反斜杠路径仍算工作区内', () => {
    const upper = resolveWorkspacePath(ws.toUpperCase(), 'sub/file.txt');
    expect(upper.ok).toBe(true);
    expect(upper.outside).toBe(false);
    const backslashArg = resolveWorkspacePath(ws, 'sub\\file.txt');
    expect(backslashArg.ok).toBe(true);
    expect(backslashArg.outside).toBe(false);
  });

  it('分隔符边界：兄弟目录 workspace-evil 不能借前缀冒充 workspace', () => {
    const evil = resolveWorkspacePath(
      ws,
      '..' + '/' + path.basename(ws) + '-evil/f.txt'
    );
    expect(evil.ok).toBe(true);
    expect(evil.outside).toBe(true);
  });

  it('工作区根未配置：ok=false', () => {
    expect(resolveWorkspacePath('', 'a.txt').ok).toBe(false);
  });
});
