import { describe, expect, it } from 'vitest';
import { buildGatewayToml, pickFreePort } from './config';

describe('buildGatewayToml', () => {
  it('含 server/api_keys/ds_core 关键结构，且无顶层 api_keys = [] 冲突', () => {
    const toml = buildGatewayToml({ port: 34567, apiKey: 'sk-fairy-x', account: null });
    expect(toml).toContain('[server]');
    expect(toml).toContain('port = 34567');
    expect(toml).toContain('host = "127.0.0.1"');
    expect(toml).toContain('[[api_keys]]');
    expect(toml).toContain('key = "sk-fairy-x"');
    // 顶层 api_keys = [] 与 [[api_keys]] 冲突会导致 TOML 解析静默失效
    expect(toml).not.toMatch(/^api_keys\s*=/m);
    expect(toml).toContain('model_types = ["default"]');
    expect(toml).not.toContain('[ds_core.accounts]');
  });

  it('手机号账号 → mobile + area_code +86 + device_id', () => {
    const toml = buildGatewayToml({
      port: 1,
      apiKey: 'k',
      account: { account: '18575112298', password: 'pw', deviceId: 'ABC==' }
    });
    expect(toml).toContain('[[ds_core.accounts]]');
    expect(toml).toContain('mobile = "18575112298"');
    expect(toml).toContain('area_code = "+86"');
    expect(toml).toContain('password = "pw"');
    expect(toml).toContain('device_id = "ABC=="');
    expect(toml).toContain('email = ""'); // 手机号账号 email 置空
  });

  it('邮箱账号 → email 字段；无 deviceId 时不写 device_id', () => {
    const toml = buildGatewayToml({
      port: 1,
      apiKey: 'k',
      account: { account: 'a@b.com', password: 'p"w' }
    });
    expect(toml).toContain('email = "a@b.com"');
    expect(toml).toContain('password = "p\\"w"'); // 引号转义
    expect(toml).not.toContain('device_id');
    expect(toml).not.toMatch(/^mobile = "1/m);
  });
});

describe('pickFreePort', () => {
  it('返回合法本地端口', async () => {
    const p = await pickFreePort();
    expect(p).toBeGreaterThan(1024);
    expect(p).toBeLessThan(65536);
  });
});
