import net from 'node:net';
import type { GatewayAccountConfig } from '../ipc';

/** ds-free-api config.toml 生成（结构照抄 docs/llm-bridge-notes.md §2 验证过的默认值） */

export interface GatewayTomlInput {
  port: number;
  apiKey: string;
  account?: GatewayAccountConfig | null;
}

function tomlStr(s: string): string {
  return JSON.stringify(s); // JSON 字符串转义与 TOML 基本兼容（"..." 形式）
}

function accountBlock(a: GatewayAccountConfig): string {
  const isEmail = a.account.includes('@');
  const isPhone = /^\d+$/.test(a.account);
  const lines: string[] = ['[[ds_core.accounts]]'];
  if (isEmail) {
    lines.push(`email = ${tomlStr(a.account)}`);
    lines.push('mobile = ""');
    lines.push('area_code = ""');
  } else if (isPhone) {
    lines.push('email = ""');
    lines.push(`mobile = ${tomlStr(a.account)}`);
    lines.push('area_code = "+86"');
  } else {
    // 兜底按邮箱处理
    lines.push(`email = ${tomlStr(a.account)}`);
    lines.push('mobile = ""');
    lines.push('area_code = ""');
  }
  lines.push(`password = ${tomlStr(a.password)}`);
  if (a.deviceId) lines.push(`device_id = ${tomlStr(a.deviceId)}`);
  return lines.join('\n');
}

export function buildGatewayToml(input: GatewayTomlInput): string {
  const parts: string[] = [];

  parts.push('[server]');
  parts.push('host = "127.0.0.1"');
  parts.push(`port = ${input.port}`);
  parts.push('');

  // 注意：绝不能同时存在顶层 api_keys = []（TOML 冲突 → 静默回落默认配置）
  parts.push('[[api_keys]]');
  parts.push(`key = ${tomlStr(input.apiKey)}`);
  parts.push('description = "fairy"');
  parts.push('');

  parts.push('[ds_core]');
  if (input.account) {
    parts.push(accountBlock(input.account));
    parts.push('');
  }
  parts.push('api_base = "https://chat.deepseek.com/api/v0"');
  parts.push('wasm_url = "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm"');
  parts.push('user_agent = "DeepSeek/2.1.1 Android/35"');
  parts.push('client_version = "2.0.0"');
  parts.push('client_platform = "android"');
  parts.push('client_locale = "zh_CN"');
  parts.push('model_types = ["default"]');
  parts.push('max_input_tokens = [1048576]');
  parts.push('max_output_tokens = [384000]');
  parts.push('input_character_limits = [2621440]');
  parts.push('model_aliases = []');

  return parts.join('\n') + '\n';
}

/** 取一个空闲本地端口（listen(0) 后立即释放，冲突概率可忽略） */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}
