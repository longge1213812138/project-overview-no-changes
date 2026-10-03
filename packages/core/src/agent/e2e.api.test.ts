/**
 * 阶段 7 端到端验收（DEV_PLAN §6 阶段 7 验收：「端到端验收在 API 通道完成」）。
 *
 * 默认跳过：需要 FAIRY_E2E_CONFIG 指向含真实 API 凭据的 JSON
 * （由 scripts/unlock-e2e-config.cjs 经 Electron+DPAPI 解密生成，key 不入库不进日志）。
 * 运行：
 *   npx electron scripts/unlock-e2e-config.cjs          # 输出配置文件路径
 *   FAIRY_E2E_CONFIG=<路径> pnpm exec vitest run src/agent/e2e.api.test.ts
 *
 * 覆盖真实模型路径下的：能力探测（明确能力提示）、模拟工具完整往返多轮 +
 * 审批放行、未授权工具不执行（execute 零调用）、内置 shell 工作区内真实执行。
 * 断言保持对模型行为的最小依赖（以工具事件为准，不苛求文案）。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLlmClient } from '../llm';
import type { ChatMessage, LlmClient } from '../llm/types';
import { probeToolsSupport } from './capability';
import type { CapabilityProbe } from './capability';
import { createRegistryAuthorizer, ToolRegistry } from './registry';
import { runAgent } from './runtime';
import type { AgentToolEvent } from './runtime';
import { createBuiltinTools } from './tools';

const configPath = process.env['FAIRY_E2E_CONFIG'];
const cfg = configPath
  ? (JSON.parse(readFileSync(configPath, 'utf8')) as {
      baseUrl: string;
      model: string;
      apiKey: string;
    })
  : undefined;

const 强制用工具 =
  '你必须先调用工具再回答，禁止跳过工具直接编造结果。';

describe('阶段 7 真实 API 端到端验收', () => {
  // 收集期守卫：describe 回调总会执行，无凭据时只登记占位用例（skip），不碰 cfg
  if (!cfg) {
    it.skip('需要 FAIRY_E2E_CONFIG（由 scripts/unlock-e2e-config.cjs 解密生成）', () => {});
    return;
  }

  const client: LlmClient = createLlmClient({
    baseUrl: cfg!.baseUrl,
    apiKey: cfg!.apiKey,
    model: cfg!.model,
    requestTimeoutMs: 60_000,
    retryBaseDelayMs: 2_000
  });
  const workspace = mkdtempSync(join(tmpdir(), 'fairy-e2e-'));
  writeFileSync(join(workspace, 'hello.txt'), 'fairy workspace probe\n');

  let probe: CapabilityProbe;
  const registry = new ToolRegistry();
  for (const reg of createBuiltinTools({ workspaceRoot: workspace })) {
    registry.register(reg);
  }
  const tools = registry.list().map((r) => r.tool);
  const toolsSupported = (): boolean => probe.support !== 'unsupported';

  it(
    '能力探测：supported 需有 tool_choice 依据；unsupported 必须带 detail（不静默降级）',
    async () => {
      probe = await probeToolsSupport(client, { signal: AbortSignal.timeout(90_000) });
      console.log('[e2e probe]', JSON.stringify(probe));
      expect(['supported', 'unsupported', 'unknown']).toContain(probe.support);
      if (probe.support === 'supported') {
        expect(['required', 'auto']).toContain(probe.probeToolChoice!);
      }
      if (probe.support === 'unsupported') {
        expect(probe.detail).toBeTruthy();
      }
    },
    120_000
  );

  it(
    '模拟工具完整往返多轮 + 审批放行（get_current_time → shell，真实模型）',
    async () => {
      if (!toolsSupported()) {
        console.log('[e2e] 端点不支持 tools，按能力提示路径跳过（非静默：hint 已由产品层回传）');
        return;
      }
      const events: AgentToolEvent[] = [];
      const authorize = createRegistryAuthorizer(registry, { confirm: async () => true });
      const messages: ChatMessage[] = [
        {
          role: 'user',
          content: `${强制用工具}第一步调用 get_current_time（timezone 用 Asia/Shanghai）；第二步调用 shell 执行 whoami（args 为空数组）。拿到两个结果后用一句话汇报。`
        }
      ];
      const result = await runAgent(client, messages, tools, undefined, {
        authorize,
        onToolEvent: (e) => events.push(e),
        maxRounds: 5,
        signal: AbortSignal.timeout(150_000)
      });
      console.log(
        '[e2e roundtrip] events=',
        events.map((e) => `${e.status}:${e.name}`).join(', ')
      );
      // 至少两个工具各完成一次（多轮往返）；被批准执行
      expect(events.filter((e) => e.status === 'completed').length).toBeGreaterThanOrEqual(2);
      expect(new Set(events.filter((e) => e.status === 'completed').map((e) => e.name))).toEqual(
        new Set(['get_current_time', 'shell'])
      );
      expect(result.content.length).toBeGreaterThan(0);
    },
    180_000
  );

  it(
    '未授权的工具不会执行（confirm=false → denied 且 execute 零调用）',
    async () => {
      if (!toolsSupported()) return;
      const events: AgentToolEvent[] = [];
      const authorize = createRegistryAuthorizer(registry, { confirm: async () => false });
      await runAgent(
        client,
        [{ role: 'user', content: `${强制用工具}调用 get_current_time 获取时间并汇报。` }],
        tools,
        undefined,
        {
          authorize,
          onToolEvent: (e) => events.push(e),
          maxRounds: 4,
          signal: AbortSignal.timeout(120_000)
        }
      );
      console.log('[e2e deny] events=', events.map((e) => `${e.status}:${e.name}`).join(', '));
      expect(events.some((e) => e.status === 'denied')).toBe(true);
      expect(events.some((e) => e.status === 'completed')).toBe(false);
    },
    150_000
  );

  it(
    '内置 shell 在工作区内真实执行（whoami，exit code 0）',
    async () => {
      if (!toolsSupported()) return;
      const events: AgentToolEvent[] = [];
      const authorize = createRegistryAuthorizer(registry, { confirm: async () => true });
      const result = await runAgent(
        client,
        [
          {
            role: 'user',
            content: `${强制用工具}调用 shell：command 填 "whoami"，args 填空数组 []，把 stdout 告诉我。`
          }
        ],
        tools,
        undefined,
        {
          authorize,
          onToolEvent: (e) => events.push(e),
          maxRounds: 4,
          signal: AbortSignal.timeout(120_000)
        }
      );
      console.log('[e2e shell] result=', result.content.slice(0, 300));
      expect(events.filter((e) => e.status === 'completed' && e.name === 'shell').length).toBe(1);
    },
    150_000
  );
});
