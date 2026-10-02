import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGatewayManager } from './manager';

const BIN = 'C:\\Users\\91533\\.fairy-tools\\ds-free-api\\ds-free-api-v0.2.11-windows-x86_64\\ds-free-api.exe';
const HAS_BIN = existsSync(BIN);

const dirs: string[] = [];
function makeDirs(): { configPath: string; dataDir: string } {
  const base = mkdtempSync(path.join(tmpdir(), 'fairy-gw-'));
  dirs.push(base);
  return { configPath: path.join(base, 'config.toml'), dataDir: path.join(base, 'data') };
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!HAS_BIN)('gateway manager 集成（真实二进制，不配置账号）', () => {
  it('start → ready → /health 200 → stop → 端口释放', { timeout: 30_000 }, async () => {
    const { configPath, dataDir } = makeDirs();
    const m = createGatewayManager({
      binPath: BIN,
      configPath,
      dataDir,
      apiKey: 'sk-fairy-itest',
      account: null,
      readyTimeoutMs: 15_000
    });

    const states: string[] = [];
    const off = m.onState((s) => states.push(s.status));

    const s1 = await m.start();
    expect(s1.status).toBe('ready');
    expect(s1.port).toBeGreaterThan(0);
    expect(s1.accountStatus).toBe('none');

    const res = await fetch(`http://127.0.0.1:${s1.port}/health`);
    expect(res.status).toBe(200);

    const port = s1.port!;
    await m.stop();
    expect(m.getSnapshot().status).toBe('stopped');
    expect(m.getSnapshot().port).toBeNull();

    // 端口应已释放（连接被拒）
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();

    off();
    expect(states).toContain('starting');
    expect(states).toContain('ready');
    expect(states).toContain('stopped');
  });

  it('stop 幂等（未运行/重复调用）', { timeout: 30_000 }, async () => {
    const { configPath, dataDir } = makeDirs();
    const m = createGatewayManager({ binPath: BIN, configPath, dataDir, apiKey: 'k', account: null });
    await m.stop();
    await m.stop();
    expect(m.getSnapshot().status).toBe('stopped');
  });
});

describe('gateway manager 单元行为', () => {
  it('binPath 不存在 → start 返回 error 快照（不 reject）', { timeout: 30_000 }, async () => {
    const { configPath, dataDir } = makeDirs();
    const m = createGatewayManager({
      binPath: path.join(tmpdir(), 'definitely-missing-gw.exe'),
      configPath,
      dataDir,
      apiKey: 'k',
      account: null,
      readyTimeoutMs: 3000
    });
    const s = await m.start();
    expect(s.status).toBe('error');
    expect(s.lastError).toBeTruthy();
    await m.stop();
  });
});
