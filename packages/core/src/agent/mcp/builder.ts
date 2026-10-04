/**
 * 阶段 8：MCP 工具 → ToolRegistration 装配（DEV_PLAN §5.8 统一注册表）。
 *
 * 安全不变量：
 * - **审批恒 ask**；**risk 恒 'exec'**——外部服务能力不可验证，取最保守徽标
 *   （MCP 不声明风险；宁可高显，不给用户「只读」错觉）；
 * - definition.description 带 MCP 服务名（审批对话框展示「谁提供的工具」，
 *   SOURCE_LABEL 映射 'mcp' →「扩展」徽标）；
 * - 入参按服务端 inputSchema 宽松校验（子集生效、子集外关键字忽略——
 *   外部 schema 不受我方控制，绝不因不支持而空校验；返回值结构由 client 严格校验）；
 * - 工具名与现有注册冲突 → 跳过该工具并记可见错误（连接不断，
 *   与 skill 的整包语义区分：服务是长驻连接资源，见实施备注）。
 */
import type { ChatToolDefinition } from '../../llm/types';
import type { ToolRegistration } from '../registry';
import type { AgentToolContext } from '../runtime';
import { validateAgainstSchema } from '../skill/schema';
import type { McpCallResult, McpClient, McpToolInfo } from './client';

export interface McpBuildContext {
  /** 现有已注册工具名（builtin / skill / 其他 mcp） */
  existingNames: readonly string[];
}

export interface McpBuildResult {
  registrations: ToolRegistration[];
  /** 跳过的工具（冲突/结构问题）——可见错误 */
  errors: { server: string; tool: string; message: string }[];
}

function provenanceLine(serverName: string): string {
  return `｜来自 MCP 服务「${serverName}」（每次调用需审批）`;
}

/** 把一个已就绪客户端的工具装配成注册项（可直接 register） */
export function buildMcpRegistrations(
  client: McpClient,
  ctx: McpBuildContext
): McpBuildResult {
  const result: McpBuildResult = { registrations: [], errors: [] };
  const claimed = new Set(ctx.existingNames);

  for (const tool of client.tools as McpToolInfo[]) {
    if (claimed.has(tool.name)) {
      result.errors.push({
        server: client.serverName,
        tool: tool.name,
        message: `工具名与现有工具冲突，已跳过：${tool.name}`
      });
      continue;
    }
    const schema = tool.inputSchema;
    const checkInput = (value: unknown): string | null => validateAgainstSchema(schema, value, '入参');
    const definition: ChatToolDefinition = {
      type: 'function',
      function: {
        name: tool.name,
        description: (tool.description || 'MCP 工具') + provenanceLine(client.serverName),
        parameters: schema
      }
    };
    result.registrations.push({
      risk: 'exec',
      approval: 'ask',
      source: 'mcp',
      assess: (value: unknown) => {
        const err = checkInput(value);
        return err === null ? { decision: 'allow' } : { decision: 'deny', reason: err };
      },
      tool: {
        definition,
        validateInput: (value: unknown) => checkInput(value) === null,
        async execute(raw: unknown, agentCtx: AgentToolContext): Promise<McpCallResult> {
          const err = checkInput(raw);
          if (err !== null) throw new Error(err); // 防御纵深：execute 前再校验
          return await client.callTool(tool.name, raw, {
            ...(agentCtx.signal !== undefined ? { signal: agentCtx.signal } : {})
          });
        }
      }
    });
    claimed.add(tool.name);
  }

  return result;
}
