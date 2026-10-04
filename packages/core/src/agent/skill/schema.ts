/**
 * 阶段 8：JSON Schema 子集校验器（Skill/MCP 工具入参，DEV_PLAN §5.8）。
 *
 * 零依赖实现，支持的子集（tool schema 常用的 draft-07 形状）：
 * - type：string/number/integer/boolean/object/array/null（或其数组，如 ["string","null"]）
 * - object：properties / required / additionalProperties(false/true)
 * - array：items / minItems / maxItems
 * - string：minLength / maxLength / pattern
 * - number：minimum / maximum
 * - 通用：enum / const（description 等注解关键字忽略不参与校验）
 *
 * 两侧用法不同（安全语义不同，勿混用）：
 * - Skill（manifest.inputSchema）：**严格模式**——loadSkillManifest 先用
 *   collectUnsupportedKeywords 查出子集外关键字并拒绝整包（fail-visible，
 *   绝不静默少校验）；运行期 validateAgainstSchema 精确校验。
 * - MCP（外部服务提供，无法控制其 schema）：**宽松模式**——子集外关键字忽略，
 *   只按能理解的部分校验（结构/必填/类型仍然生效），绝不因不支持而放行空校验。
 *
 * 返回值约定：validateAgainstSchema 返回 null = 通过；否则返回首个可读错误。
 */

/** 注解关键字：不参与校验（合法但不影响判定） */
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'examples', 'default', 'deprecated'])

/** 支持的关键字（严格模式白名单；不含注解与 $ref 等结构外能力） */
export const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'enum',
  'const'
])

/** JSON Schema 对象（子集） */
export type JsonSchema = Record<string, unknown>

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 收集子集外的关键字（递归进 properties/items 的子 schema；注解忽略）。
 * 严格模式用：非空 → Skill manifest 拒绝，错误信息列出全部不支持项。
 */
export function collectUnsupportedKeywords(schema: unknown, out: Set<string> = new Set()): Set<string> {
  if (!isPlainObject(schema)) return out
  for (const [key, value] of Object.entries(schema)) {
    if (ANNOTATION_KEYWORDS.has(key)) continue
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      out.add(key)
      continue
    }
    if (key === 'properties' && isPlainObject(value)) {
      for (const sub of Object.values(value)) collectUnsupportedKeywords(sub, out)
    } else if (key === 'items') {
      collectUnsupportedKeywords(value, out)
    }
  }
  return out
}

function typeMatches(expected: string, value: unknown): boolean {
  switch (expected) {
    case 'null':
      return value === null
    case 'string':
      return typeof value === 'string'
    case 'boolean':
      return typeof value === 'boolean'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isPlainObject(value)
    default:
      return false // 未知 type：由 collectUnsupported 在严格模式拦截；宽松模式视为不匹配
  }
}

function validateType(schema: JsonSchema, value: unknown, path: string): string | null {
  const t = schema['type']
  if (typeof t === 'string') {
    return typeMatches(t, value) ? null : `${path} 类型应为 ${t}，实际为 ${describeValue(value)}`
  }
  if (Array.isArray(t)) {
    const names = t.filter((x): x is string => typeof x === 'string')
    if (names.some((name) => typeMatches(name, value))) return null
    return `${path} 类型应为 ${names.join(' | ')}，实际为 ${describeValue(value)}`
  }
  return null // 无 type：只按其他关键字约束
}

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function validateString(schema: JsonSchema, value: string, path: string): string | null {
  const min = schema['minLength']
  if (typeof min === 'number' && value.length < min) {
    return `${path} 长度不足（最少 ${min} 字符）`
  }
  const max = schema['maxLength']
  if (typeof max === 'number' && value.length > max) {
    return `${path} 过长（最多 ${max} 字符）`
  }
  const pattern = schema['pattern']
  if (typeof pattern === 'string') {
    try {
      if (!new RegExp(pattern).test(value)) return `${path} 不匹配 pattern(${pattern})`
    } catch {
      // 非法 pattern：宽松模式忽略（严格模式在 manifest 解析期已拦截）
    }
  }
  return null
}

function validateNumber(schema: JsonSchema, value: number, path: string): string | null {
  const min = schema['minimum']
  if (typeof min === 'number' && value < min) return `${path} 小于 minimum(${min})`
  const max = schema['maximum']
  if (typeof max === 'number' && value > max) return `${path} 大于 maximum(${max})`
  return null
}

function validateObject(schema: JsonSchema, value: Record<string, unknown>, path: string): string | null {
  const required = schema['required']
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key !== 'string') continue
      if (!(key in value) || value[key] === undefined) {
        return `${path} 缺少必填字段「${key}」`
      }
    }
  }
  const properties = schema['properties']
  if (isPlainObject(properties)) {
    for (const [key, sub] of Object.entries(properties)) {
      if (key in value && value[key] !== undefined) {
        const err = validateAgainstSchema(sub, value[key], `${path}.${key}`)
        if (err !== null) return err
      }
    }
    const additional = schema['additionalProperties']
    if (additional === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          return `${path} 含未知字段「${key}」（additionalProperties=false）`
        }
      }
    }
  }
  return null
}

function validateArray(schema: JsonSchema, value: unknown[], path: string): string | null {
  const min = schema['minItems']
  if (typeof min === 'number' && value.length < min) {
    return `${path} 元素数量不足（最少 ${min}）`
  }
  const max = schema['maxItems']
  if (typeof max === 'number' && value.length > max) {
    return `${path} 元素过多（最多 ${max}）`
  }
  const items = schema['items']
  if (items !== undefined) {
    for (let i = 0; i < value.length; i++) {
      const err = validateAgainstSchema(items, value[i], `${path}[${i}]`)
      if (err !== null) return err
    }
  }
  return null
}

/**
 * 按子集 schema 校验值。
 * @param schema 子 schema（非对象视为放行约束，仅由调用方保证 shape）
 * @param value 待校验值
 * @param path 错误定位前缀（顶层传 '.'）
 * @returns null = 通过；否则首个错误的可读描述
 */
export function validateAgainstSchema(schema: unknown, value: unknown, path = '.'): string | null {
  if (!isPlainObject(schema)) return null
  const err = validateType(schema, value, path)
  if (err !== null) return err

  const enumValues = schema['enum']
  if (Array.isArray(enumValues) && !enumValues.some((x) => Object.is(x, value))) {
    return `${path} 不在允许取值内（enum）`
  }
  if ('const' in schema && !Object.is(schema['const'], value)) {
    return `${path} 必须等于 const 指定值`
  }

  if (typeof value === 'string') return validateString(schema, value, path)
  if (typeof value === 'number') return validateNumber(schema, value, path)
  if (Array.isArray(value)) return validateArray(schema, value, path)
  if (isPlainObject(value)) return validateObject(schema, value, path)
  return null
}
