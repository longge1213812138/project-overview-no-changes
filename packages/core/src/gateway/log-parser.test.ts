import { describe, expect, it } from 'vitest';
import { parseGatewayLine } from './log-parser';

describe('parseGatewayLine', () => {
  it('登录成功', () => {
    const r = parseGatewayLine(
      '[INFO ds_core::accounts] Account 18575112298 initialized successfully'
    );
    expect(r).toEqual({ accountStatus: 'logged_in', accountDetail: null });
  });

  it('code=11 → RISK_DEVICE_DETECTED', () => {
    const r = parseGatewayLine(
      '[WARN ds_core::accounts] Account x initialization failed: 客户端错误: Business error: code=11, msg=RISK_DEVICE_DETECTED'
    );
    expect(r?.accountStatus).toBe('login_failed');
    expect(r?.accountDetail).toContain('RISK_DEVICE_DETECTED');
  });

  it('code=10 → USER_IS_BANNED', () => {
    const r = parseGatewayLine('Account x initialization failed: Business error: code=10, msg=USER_IS_BANNED');
    expect(r?.accountDetail).toContain('USER_IS_BANNED');
  });

  it('code=5 → user is muted', () => {
    const r = parseGatewayLine('Business error: code=5, msg=user is muted, mute_until=...');
    expect(r?.accountDetail).toContain('muted');
  });

  it('All accounts failed → login_failed', () => {
    const r = parseGatewayLine('[WARN ds_core::accounts] All accounts failed to initialize — they may be disabled or have invalid credentials');
    expect(r).toEqual({ accountStatus: 'login_failed', accountDetail: '所有账号初始化失败' });
  });

  it('请求期池无可用账号', () => {
    const r = parseGatewayLine('[WARN ds_core::accounts] req=req-0 账号池无可用账号');
    expect(r).toEqual({ accountStatus: 'login_failed', accountDetail: '账号池无可用账号' });
  });

  it('无关行 → null', () => {
    expect(parseGatewayLine('[INFO http::server] 管理面板: http://127.0.0.1:22217/admin')).toBeNull();
    expect(parseGatewayLine('')).toBeNull();
  });
});
