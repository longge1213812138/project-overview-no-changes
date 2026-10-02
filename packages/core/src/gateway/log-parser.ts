/** ds-free-api 运行日志行 → 账号登录态（指纹见 docs/llm-bridge-notes.md §4） */

export interface LogParseResult {
  accountStatus: 'logged_in' | 'login_failed';
  accountDetail: string | null;
}

function classifyBizCode(line: string): string | null {
  const code = line.match(/code\s*=\s*(\d+)/)?.[1];
  if (code === '11' || line.includes('RISK_DEVICE_DETECTED')) {
    return 'RISK_DEVICE_DETECTED（缺 device_id 或指纹被拒）';
  }
  if (code === '10' || line.includes('USER_IS_BANNED')) {
    return 'USER_IS_BANNED（账号被封禁）';
  }
  if (code === '5' || line.includes('user is muted')) {
    return 'user is muted（账号被临时禁言）';
  }
  return null;
}

/**
 * 解析单行网关输出。只关心账号登录结果，其余返回 null（不改变状态）。
 * 顺序敏感：具体失败原因优先于笼统的 All accounts failed。
 */
export function parseGatewayLine(line: string): LogParseResult | null {
  if (line.includes('initialized successfully')) {
    return { accountStatus: 'logged_in', accountDetail: null };
  }
  if (line.includes('initialization failed') || line.includes('Business error')) {
    const detail =
      classifyBizCode(line) ?? line.trim().slice(0, 200);
    return { accountStatus: 'login_failed', accountDetail: detail };
  }
  if (line.includes('All accounts failed')) {
    return { accountStatus: 'login_failed', accountDetail: '所有账号初始化失败' };
  }
  if (line.includes('账号池无可用账号')) {
    // 请求期信号：池内没有可用账号（可能登录中，也可能是凭据失效）
    return { accountStatus: 'login_failed', accountDetail: '账号池无可用账号' };
  }
  return null;
}
