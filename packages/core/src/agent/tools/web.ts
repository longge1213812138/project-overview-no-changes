/**
 * 阶段 10：联网内置工具 `web_search` / `web_fetch`（DEV_PLAN §5.10）。
 *
 * 与阶段 7 的 shell 工具同构：注册项（元信息 + schema）+ 审批 + 执行，两处额外约定：
 * - **审批恒 ask**：模型在工具循环里要联网，必须逐次经用户确认（与阶段 8 Skill/MCP 的
 *   外部面一律 ask 同取向）；「用户明确要求/时效信号」触发的预检索走管线，不经审批
 *   （两条路径的口径对照见 DEV_PLAN §5.10）。
 * - **URL 守卫前置**：`web_fetch` 的 assess 先跑 checkWebUrl（协议/凭据/内网 SSRF/端口），
 *   不通过直接 deny，**不进审批**（与 shell 拒绝名单同理：明显有害不劳烦用户）。
 * - 网络实现由 main 侧注入（core/web 的 searchWeb / fetchWebPage），本文件不直接发请求：
 *   便于单测，且保证「用户配置 + 超时」只有一个出口负责。
 */
import type { ChatToolDefinition } from '../../llm/types';
import type { ToolAssessment, ToolRegistration } from '../registry';
import type { AgentToolContext } from '../runtime';
import type { WebFetchResult, WebSearchResult } from '../../web/types';
import { checkWebUrl } from '../../web/urlguard';

const SEARCH_DEFINITION: ChatToolDefinition = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      '联网检索：输入检索词，返回若干条结果（标题/链接/摘要）。仅在用户允许联网时可用；用于获取最新或本地资料库没有的信息',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词（自然语言，去掉命令式措辞）' },
        maxResults: { type: 'number', description: '返回条数上限（1-10，缺省按配置）' }
      },
      required: ['query'],
      additionalProperties: false
    }
  }
};

const FETCH_DEFINITION: ChatToolDefinition = {
  type: 'function',
  function: {
    name: 'web_fetch',
    description: '抓取指定 http(s) 页面并抽取正文（内网/本机地址一律拒绝）',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http/https 页面地址' },
        maxChars: { type: 'number', description: '正文字符上限（500-20000，缺省按配置）' }
      },
      required: ['url'],
      additionalProperties: false
    }
  }
};

export interface WebToolDeps {
  /** 检索实现（main 侧注入：saltar-searchWeb 带着用户配置） */
  search: (query: string, opts: { maxResults?: number; signal?: AbortSignal }) => Promise<WebSearchResult>;
  /** 抓取实现（main 侧注入：core fetchWebPage 带用户配置） */
  fetchPage: (
    url: string,
    opts: { maxChars?: number; signal?: AbortSignal }
  ) => Promise<WebFetchResult>;
}

export interface WebSearchInput {
  query: string;
  maxResults?: number;
}

export interface WebFetchInput {
  url: string;
  maxChars?: number;
}

/** 检索结果 / 失败统统返回给模型（失败可见，模型可换词重试），不抛异常伪装成功 */
export interface WebSearchOutput {
  query: string;
  count: number;
  items: { title: string; url: string; snippet: string }[];
  error?: string;
}

export interface WebFetchOutput {
  url: string;
  title?: string;
  content?: string;
  truncated?: boolean;
  error?: string;
}

function isSearchInput(value: unknown): value is WebSearchInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'query' && key !== 'maxResults') return false;
  }
  if (typeof record.query !== 'string' || record.query.trim() === '') return false;
  if ('maxResults' in record && record.maxResults !== undefined) {
    const n = record.maxResults;
    if (typeof n !== 'number' || !Number.isFinite(n)) return false;
    if (!Number.isInteger(n) || n < 1 || n > 10) return false;
  }
  return true;
}

function isFetchInput(value: unknown): value is WebFetchInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'url' && key !== 'maxChars') return false;
  }
  if (typeof record.url !== 'string' || record.url.trim() === '') return false;
  if ('maxChars' in record && record.maxChars !== undefined) {
    const n = record.maxChars;
    if (typeof n !== 'number' || !Number.isFinite(n)) return false;
    if (!Number.isInteger(n) || n < 500 || n > 20_000) return false;
  }
  return true;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
  }
}

/** web_fetch 的策略钩子：URL 未过守卫 → deny（不进审批），其余 allow */
function assessFetch(value: unknown): ToolAssessment {
  if (!isFetchInput(value)) {
    return { decision: 'deny', reason: '参数结构不合法' };
  }
  const check = checkWebUrl(value.url);
  if (!check.ok) {
    return { decision: 'deny', reason: check.reason ?? 'URL 未通过安全校验' };
  }
  return { decision: 'allow' };
}

/** web_search 的策略钩子：只做结构与长度 Defence（每条 Rendered 仍在 core/web 侧过滤） */
function assessSearch(value: unknown): ToolAssessment {
  if (!isSearchInput(value)) {
    return { decision: 'deny', reason: '参数结构不合法' };
  }
  if (value.query.trim().length > 200) {
    return { decision: 'deny', reason: '检索词过长（上限 200 字符）' };
  }
  return { decision: 'allow' };
}

/** 构造两个联网工具的注册项（顺序：检索、抓取） */
export function createWebTools(deps: WebToolDeps): ToolRegistration[] {
  return [
    {
      risk: 'read',
      approval: 'ask',
      source: 'builtin',
      assess: assessSearch,
      tool: {
        definition: SEARCH_DEFINITION,
        validateInput: isSearchInput,
        async execute(raw: unknown, ctx: AgentToolContext): Promise<WebSearchOutput> {
          if (!isSearchInput(raw)) throw new Error('参数结构不合法');
          if (assessSearch(raw).decision === 'deny') {
            throw new Error(assessSearch(raw).reason ?? '工具策略拒绝执行');
          }
          throwIfAborted(ctx.signal);
          const query = raw.query.trim();
          const result = await deps.search(query, {
            ...(raw.maxResults !== undefined ? { maxResults: raw.maxResults } : {}),
            ...(ctx.signal !== undefined ? { signal: ctx.signal } : {})
          });
          return {
            query: result.query,
            count: result.items.length,
            items: result.items.map((item) => ({
              title: item.title,
              url: item.url,
              snippet: item.snippet
            })),
            ...(result.error !== undefined ? { error: result.error } : {})
          };
        }
      }
    },
    {
      risk: 'read',
      approval: 'ask',
      source: 'builtin',
      assess: assessFetch,
      tool: {
        definition: FETCH_DEFINITION,
        validateInput: isFetchInput,
        async execute(raw: unknown, ctx: AgentToolContext): Promise<WebFetchOutput> {
          if (!isFetchInput(raw)) throw new Error('参数结构不合法');
          // 防御纵深：执行前再跑一次与 assess 等价的守卫
          const assessment = assessFetch(raw);
          if (assessment.decision === 'deny') {
            throw new Error(assessment.reason ?? '工具策略拒绝执行');
          }
          throwIfAborted(ctx.signal);
          const result = await deps.fetchPage(raw.url.trim(), {
            ...(raw.maxChars !== undefined ? { maxChars: raw.maxChars } : {}),
            ...(ctx.signal !== undefined ? { signal: ctx.signal } : {})
          });
          if (result.error !== undefined) {
            return { url: result.url, error: result.error };
          }
          return {
            url: result.url,
            title: result.title,
            content: result.content,
            truncated: result.truncated
          };
        }
      }
    }
  ];
}
