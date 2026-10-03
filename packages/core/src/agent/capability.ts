/**
 * 阶段 7：tools 工具调用能力探测（DEV_PLAN §6 阶段 7 任务 1）。
 *
 * Fairy 有两条 LLM 通道：api（OpenAI 兼容直连）与 web（本地网关）；阶段 7 决定
 * tools 工具调用只走 api 通道。本模块给出 probeToolsSupport：向 LlmClient 发一次
 * 非流式小调用（占位工具 capability_probe + tool_choice），判定端点是否支持
 * OpenAI function calling，供调用方在不支持的通道上给出明确能力提示，
 * 而不是做成功形状的静默降级。
 *
 * 约定：
 * - 结果三态：supported / unsupported / unknown；unknown 表示探测本身失败
 *   （400 不含 tool、5xx 重试耗尽、网络超时等），调用方应按 unknown 继续尝试
 *   带 tools 发送，由后续真实请求兜底。
 * - 不重试：探测只尝试 required → auto 各一次，失败即 unknown。
 * - 通道级错误（SessionExpiredError / LlmAuthError）原样 rethrow，
 *   由调用方既有流水处理，不得吞掉。
 * 纯 TS、web-safe（不含 node 内建）；全部非流式。
 */
import { LlmAuthError, LlmError, SessionExpiredError } from '../llm/errors';
import type {
  ChatCallOptions,
  ChatMessage,
  ChatToolDefinition,
  LlmClient
} from '../llm/types';

/** 端点对 tools 工具调用的支持判定 */
export type ToolsSupport = 'supported' | 'unsupported' | 'unknown';

export interface CapabilityProbe {
  support: ToolsSupport;
  /** 人类可读细节（错误指纹/模型未调用原因），进日志与诊断 */
  detail?: string;
  /** 实际生效的 tool_choice（诊断用） */
  probeToolChoice?: 'required' | 'auto';
}

/** 探测占位工具：无副作用，仅回显一个字符串 */
const PROBE_TOOL: ChatToolDefinition = {
  type: 'function',
  function: {
    name: 'capability_probe',
    description: '能力探测占位工具',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string', description: '回显值' } },
      required: ['value'],
      additionalProperties: false
    }
  }
};

/** 每次新建，避免客户端/测试对数组做原地修改产生串扰 */
function probeMessages(): ChatMessage[] {
  return [
    {
      role: 'user',
      content:
        '请立即调用 capability_probe 工具，value 填入字符串 "ping"，不要用普通文字回答。'
    }
  ];
}

function probeOptions(toolChoice: 'required' | 'auto', signal?: AbortSignal): ChatCallOptions {
  return { tools: [PROBE_TOOL], toolChoice, signal };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 通道级错误不吞：会话过期/鉴权失败必须冒泡给调用方既有流水 */
function isChannelError(error: unknown): boolean {
  return error instanceof SessionExpiredError || error instanceof LlmAuthError;
}

function isToolUnsupported(error: LlmError): boolean {
  return error.status === 400 && /tool/i.test(error.message);
}

/**
 * 探测端点是否支持 OpenAI function calling（tools + tool_choice）。
 *
 * 尝试 1 用 tool_choice=required 强制模型必须出工具调用；若端点只拒绝
 * tool_choice 参数（400 且 message 含 tool_choice）则降级尝试 2（tool_choice=auto）。
 * 非流式、不重试；SessionExpiredError / LlmAuthError 原样 rethrow。
 */
export async function probeToolsSupport(
  client: LlmClient,
  options: { signal?: AbortSignal } = {}
): Promise<CapabilityProbe> {
  const { signal } = options;

  // 尝试 1：tool_choice=required，模型必须调用工具
  try {
    const result = await client.chatOnce(probeMessages(), probeOptions('required', signal));
    if (result.toolCalls && result.toolCalls.length > 0) {
      return { support: 'supported', probeToolChoice: 'required' };
    }
    // required 却没出工具调用：无法判定能力，归 unknown 交给真实请求兜底
    return { support: 'unknown', detail: '模型未返回工具调用（tool_choice=required）' };
  } catch (error) {
    if (isChannelError(error)) throw error;
    if (error instanceof LlmError && error.status === 400) {
      // 端点不认识 tool_choice 参数 → 降级用 auto 再试一次
      if (/tool_choice/i.test(error.message)) {
        return probeWithAuto(client, signal);
      }
      // 端点连 tools 参数都不认（如 "Unknown parameter: 'tools'"）→ 明确不支持
      if (/tool/i.test(error.message)) {
        return { support: 'unsupported', detail: error.message };
      }
    }
    return { support: 'unknown', detail: errorDetail(error) };
  }
}

/** 尝试 2：仅当尝试 1 因 tool_choice 被拒时执行，改用 tool_choice=auto */
async function probeWithAuto(client: LlmClient, signal?: AbortSignal): Promise<CapabilityProbe> {
  try {
    const result = await client.chatOnce(probeMessages(), probeOptions('auto', signal));
    if (result.toolCalls && result.toolCalls.length > 0) {
      return { support: 'supported', probeToolChoice: 'auto' };
    }
    return { support: 'unknown', detail: '模型未返回工具调用（tool_choice=auto）' };
  } catch (error) {
    if (isChannelError(error)) throw error;
    if (error instanceof LlmError && isToolUnsupported(error)) {
      return { support: 'unsupported', detail: error.message };
    }
    return { support: 'unknown', detail: errorDetail(error) };
  }
}
