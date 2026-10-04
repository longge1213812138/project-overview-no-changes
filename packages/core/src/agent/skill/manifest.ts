/**
 * 阶段 8：Skill manifest（skill.json）解析与严格校验（DEV_PLAN §5.8）。
 *
 * 安全立场（实现前细化的信任/分发策略，见 DEV_PLAN 阶段 8 实施备注）：
 * - manifest 是**声明**而非证明：risk/permissions 都由作者自述，供审批 UI 展示；
 *   真正的边界 = 默认禁用 + 内容指纹启用确认 + 每次调用审批（approval 恒 ask）。
 * - **严格 fail-visible**：未知顶层键、未知工具键、子集外 schema 关键字、
 *   非法路径 entry 一律整包拒绝并给出精确错误——绝不静默少校验。
 * - schemaVersion 不匹配 → 拒绝（结构演进必须走版本号，不允许"宽松兼容"）。
 */
import { collectUnsupportedKeywords, type JsonSchema } from './schema';

/** manifest 文件名（skill 包目录内） */
export const SKILL_MANIFEST_FILENAME = 'skill.json';
/** 当前 manifest 结构版本 */
export const SKILL_SCHEMA_VERSION = 1;

/** 声明式权限值域（展示与门控认知；运行时无 OS 沙箱，见实施备注如实声明） */
export const SKILL_PERMISSIONS = ['workspace:read', 'workspace:write', 'network', 'system:info'] as const;
export type SkillPermission = (typeof SKILL_PERMISSIONS)[number];

/** 工具名约束（与 ToolRegistry 相同的 OpenAI function name 规则） */
export const SKILL_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** 技能名约束（同工具名，保证作为前缀/标识安全） */
export const SKILL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** 语义化版本（x.y.z，允许 -预发布后缀） */
export const SKILL_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;

/** 单个工具声明（manifest.tools[] 归一化结果） */
export interface SkillToolManifest {
  name: string;
  description: string;
  /** 作者声明的风险级别（展示用；审批恒 ask 不依赖它放行） */
  risk: 'read' | 'write' | 'exec';
  /** 入参 JSON Schema（type 必须为 object；仅支持子集关键字） */
  inputSchema: JsonSchema;
  /** 相对 skill 目录的脚本路径（禁止 ..、绝对路径、盘符；仅 .js/.mjs/.cjs） */
  entry: string;
  /** 单次执行超时（毫秒，缺省 10000，上限 60000） */
  timeoutMs: number;
}

/** skill.json 归一化结果 */
export interface SkillManifest {
  schemaVersion: 1;
  name: string;
  version: string;
  description: string;
  /** 来源自述（作者/主页/URL/local）：审批与设置页展示，必填非空 */
  source: string;
  permissions: SkillPermission[];
  tools: SkillToolManifest[];
}

/** manifest 校验失败（错误信息 = 展示给用户的可见原因） */
export class SkillManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillManifestError';
  }
}

/** 默认/上限执行超时 */
export const SKILL_DEFAULT_TIMEOUT_MS = 10_000;
export const SKILL_MAX_TIMEOUT_MS = 60_000;
/** manifest 规模上限（防超大 payload 拖垮加载与展示） */
export const SKILL_MAX_TOOLS = 16;
export const SKILL_MAX_DESCRIPTION_CHARS = 500;
export const SKILL_MAX_SOURCE_CHARS = 200;
export const SKILL_MAX_PERMISSIONS = 8;

const TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'name',
  'version',
  'description',
  'source',
  'permissions',
  'tools'
]);
const TOOL_KEYS = new Set(['name', 'description', 'risk', 'inputSchema', 'entry', 'timeoutMs']);

function fail(message: string): never {
  throw new SkillManifestError(message);
}

function requirePlainObject(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(`${what} 必须是 JSON 对象`);
  }
  return raw as Record<string, unknown>; // 守卫已排除 null/数组，unknown 收窄需显式断言
}

function requireNonEmptyString(value: unknown, key: string, maxChars: number): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`「${key}」必须是非空字符串`);
  if (value.length > maxChars) fail(`「${key}」过长（最多 ${maxChars} 字符）`);
  return value;
}

/** entry 路径安全：相对路径、无 ..、无盘符冒号、无前导斜杠/UNC、限定脚本后缀 */
function validateEntryPath(entry: string): void {
  if (entry.trim() === '') fail('tools[].entry 必须是非空相对路径');
  if (/^[A-Za-z]:/.test(entry)) fail(`tools[].entry 不允许盘符路径：${entry}`);
  if (entry.startsWith('/') || entry.startsWith('\\')) fail(`tools[].entry 必须是相对路径：${entry}`);
  if (entry.includes('\\\\')) fail(`tools[].entry 不允许 UNC 路径：${entry}`);
  const segments = entry.split(/[\\/]+/);
  if (segments.some((seg) => seg === '..')) fail(`tools[].entry 不允许向上穿越（..）：${entry}`);
  if (segments.some((seg) => seg === '.' || seg === '')) fail(`tools[].entry 路径段不合法：${entry}`);
  const lower = entry.toLowerCase();
  if (!lower.endsWith('.js') && !lower.endsWith('.mjs') && !lower.endsWith('.cjs')) {
    fail(`tools[].entry 必须是 .js/.mjs/.cjs 脚本：${entry}`);
  }
}

/** inputSchema：必须是 object 类型 schema，且只含支持的子集关键字（严格模式） */
function validateInputSchema(raw: unknown, toolName: string): JsonSchema {
  const schema = requirePlainObject(raw, `工具「${toolName}」的 inputSchema`);
  if (schema['type'] !== 'object') {
    fail(`工具「${toolName}」的 inputSchema.type 必须是 "object"（工具入参恒为对象）`);
  }
  const unsupported = collectUnsupportedKeywords(schema);
  if (unsupported.size > 0) {
    fail(
      `工具「${toolName}」的 inputSchema 含不支持的关键字：${[...unsupported].sort().join('、')}` +
        `（支持子集见实施备注；不静默少校验）`
    );
  }
  if ('pattern' in schema && typeof schema['pattern'] === 'string') {
    try {
      new RegExp(schema['pattern']);
    } catch {
      fail(`工具「${toolName}」的 inputSchema.pattern 不是合法正则：${String(schema['pattern'])}`);
    }
  }
  // properties 子 schema 的 pattern 也要能在构造期通过（宽松放过会被运行期 try/catch 吃掉，
  // 严格模式要求此刻可见）——collectUnsupported 已递归，这里同样递归查一遍正则合法性
  const checkPatterns = (node: unknown): void => {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return;
    const record = node as Record<string, unknown>;
    if (typeof record['pattern'] === 'string') {
      try {
        new RegExp(record['pattern']);
      } catch {
        fail(`工具「${toolName}」的 inputSchema 含非法正则 pattern：${record['pattern']}`);
      }
    }
    const props = record['properties'];
    if (typeof props === 'object' && props !== null) {
      for (const sub of Object.values(props as Record<string, unknown>)) checkPatterns(sub);
    }
    if (record['items'] !== undefined) checkPatterns(record['items']);
  };
  checkPatterns(schema);
  return schema;
}

function parseTool(raw: unknown, index: number): SkillToolManifest {
  const tool = requirePlainObject(raw, `tools[${index}]`);
  for (const key of Object.keys(tool)) {
    if (!TOOL_KEYS.has(key)) fail(`tools[${index}] 含未知字段「${key}」`);
  }
  const name = requireNonEmptyString(tool['name'], `tools[${index}].name`, 64);
  if (!SKILL_TOOL_NAME_PATTERN.test(name)) {
    fail(`tools[${index}].name 不符合标识符约束（字母/数字/_/-，1-64）：${name}`);
  }
  const description = requireNonEmptyString(
    tool['description'],
    `工具「${name}」的 description`,
    SKILL_MAX_DESCRIPTION_CHARS
  );
  const risk = tool['risk'];
  if (risk !== 'read' && risk !== 'write' && risk !== 'exec') {
    fail(`工具「${name}」的 risk 必须是 read/write/exec 之一`);
  }
  const entry = requireNonEmptyString(tool['entry'], `工具「${name}」的 entry`, 400);
  validateEntryPath(entry);
  let timeoutMs = SKILL_DEFAULT_TIMEOUT_MS;
  if (tool['timeoutMs'] !== undefined) {
    const t = tool['timeoutMs'];
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 1000 || t > SKILL_MAX_TIMEOUT_MS) {
      fail(`工具「${name}」的 timeoutMs 必须是 1000-${SKILL_MAX_TIMEOUT_MS} 的整数毫秒`);
    }
    timeoutMs = t;
  }
  return {
    name,
    description,
    risk,
    inputSchema: validateInputSchema(tool['inputSchema'], name),
    entry,
    timeoutMs
  };
}

/**
 * 解析并严格校验 skill.json 内容（已解析的 JSON 值）。
 * 任何不合规 → SkillManifestError，message 即展示给用户的可见错误。
 */
export function parseSkillManifest(raw: unknown): SkillManifest {
  const manifest = requirePlainObject(raw, 'skill.json 根节点');
  for (const key of Object.keys(manifest)) {
    if (!TOP_LEVEL_KEYS.has(key)) fail(`skill.json 含未知字段「${key}」（结构演进请升 schemaVersion）`);
  }

  if (manifest['schemaVersion'] !== SKILL_SCHEMA_VERSION) {
    fail(`schemaVersion 不支持：期望 ${SKILL_SCHEMA_VERSION}，实际 ${JSON.stringify(manifest['schemaVersion'])}`);
  }
  const name = requireNonEmptyString(manifest['name'], 'name', 64);
  if (!SKILL_NAME_PATTERN.test(name)) fail(`name 不符合标识符约束（字母/数字/_/-，1-64）：${name}`);
  const version = requireNonEmptyString(manifest['version'], 'version', 64);
  if (!SKILL_VERSION_PATTERN.test(version)) fail(`version 必须是 semver 形式（x.y.z[-suffix]）：${version}`);
  const description = requireNonEmptyString(manifest['description'], 'description', SKILL_MAX_DESCRIPTION_CHARS);
  const source = requireNonEmptyString(manifest['source'], 'source', SKILL_MAX_SOURCE_CHARS);

  const permissions: SkillPermission[] = [];
  if (manifest['permissions'] !== undefined) {
    const list = manifest['permissions'];
    if (!Array.isArray(list)) fail('permissions 必须是数组');
    if (list.length > SKILL_MAX_PERMISSIONS) fail(`permissions 最多 ${SKILL_MAX_PERMISSIONS} 项`);
    for (const p of list) {
      if (typeof p !== 'string' || !(SKILL_PERMISSIONS as readonly string[]).includes(p)) {
        fail(`permissions 含非法取值 ${JSON.stringify(p)}（允许：${SKILL_PERMISSIONS.join(' / ')}）`);
      }
      if (permissions.includes(p as SkillPermission)) fail(`permissions 重复：${p}`);
      permissions.push(p as SkillPermission);
    }
  }

  const toolsRaw = manifest['tools'];
  if (!Array.isArray(toolsRaw) || toolsRaw.length === 0) fail('tools 必须是非空数组');
  if (toolsRaw.length > SKILL_MAX_TOOLS) fail(`tools 最多 ${SKILL_MAX_TOOLS} 个`);
  const tools = toolsRaw.map((t, i) => parseTool(t, i));
  const seen = new Set<string>();
  for (const t of tools) {
    if (seen.has(t.name)) fail(`tools 内工具名重复：${t.name}`);
    seen.add(t.name);
  }

  return {
    schemaVersion: SKILL_SCHEMA_VERSION,
    name,
    version,
    description,
    source,
    permissions,
    tools
  };
}
