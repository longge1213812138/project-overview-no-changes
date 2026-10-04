/**
 * 阶段 8：JSON Schema 子集校验器单测（Skill 严格模式 / MCP 宽松模式的共同底座）。
 */
import { describe, expect, it } from 'vitest';
import { collectUnsupportedKeywords, validateAgainstSchema } from './schema';

describe('validateAgainstSchema（子集）', () => {
  it('type 基本类型判定（含 integer / type 数组）', () => {
    expect(validateAgainstSchema({ type: 'string' }, 'x')).toBeNull();
    expect(validateAgainstSchema({ type: 'string' }, 1)).toMatch(/类型应为 string/);
    expect(validateAgainstSchema({ type: 'integer' }, 3)).toBeNull();
    expect(validateAgainstSchema({ type: 'integer' }, 3.5)).toMatch(/integer/);
    expect(validateAgainstSchema({ type: ['string', 'null'] }, null)).toBeNull();
    expect(validateAgainstSchema({ type: ['string', 'null'] }, 7)).toMatch(/string \| null/);
  });

  it('object：required / properties / additionalProperties=false', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
      additionalProperties: false
    };
    expect(validateAgainstSchema(schema, { a: 'x', b: 1 })).toBeNull();
    expect(validateAgainstSchema(schema, { b: 1 })).toMatch(/缺少必填字段「a」/);
    expect(validateAgainstSchema(schema, { a: 'x', c: true })).toMatch(/未知字段「c」/);
    expect(validateAgainstSchema(schema, { a: 5 })).toMatch(/\.a 类型应为 string/);
    expect(validateAgainstSchema(schema, 'not-object')).toMatch(/类型应为 object/);
  });

  it('嵌套 object / array 的路径定位', () => {
    const schema = {
      type: 'object',
      properties: {
        list: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }
      },
      additionalProperties: false
    };
    expect(validateAgainstSchema(schema, { list: [{ id: 'a' }] })).toBeNull();
    expect(validateAgainstSchema(schema, { list: [{ id: 1 }] })).toMatch(/\.list\[0\]\.id 类型应为 string/);
    expect(validateAgainstSchema(schema, { list: [{}] })).toMatch(/\.list\[0\] 缺少必填字段「id」/);
  });

  it('array：minItems/maxItems', () => {
    const schema = { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 };
    expect(validateAgainstSchema(schema, ['a'])).toBeNull();
    expect(validateAgainstSchema(schema, [])).toMatch(/最少 1/);
    expect(validateAgainstSchema(schema, ['a', 'b', 'c'])).toMatch(/最多 2/);
  });

  it('string：minLength/maxLength/pattern', () => {
    expect(validateAgainstSchema({ type: 'string', minLength: 2 }, 'a')).toMatch(/长度不足/);
    expect(validateAgainstSchema({ type: 'string', maxLength: 2 }, 'abc')).toMatch(/过长/);
    expect(validateAgainstSchema({ type: 'string', pattern: '^\\d+$' }, '12a')).toMatch(/pattern/);
    expect(validateAgainstSchema({ type: 'string', pattern: '^\\d+$' }, '12')).toBeNull();
    // 非法 pattern：宽松忽略（严格模式在 manifest 解析期拦截）
    expect(validateAgainstSchema({ type: 'string', pattern: '([' }, 'x')).toBeNull();
  });

  it('number：minimum/maximum；enum/const', () => {
    expect(validateAgainstSchema({ type: 'number', minimum: 1 }, 0)).toMatch(/小于 minimum/);
    expect(validateAgainstSchema({ type: 'number', maximum: 10 }, 11)).toMatch(/大于 maximum/);
    expect(validateAgainstSchema({ enum: ['a', 'b'] }, 'c')).toMatch(/enum/);
    expect(validateAgainstSchema({ enum: ['a', 'b'] }, 'b')).toBeNull();
    expect(validateAgainstSchema({ const: 42 }, 41)).toMatch(/const/);
    expect(validateAgainstSchema({ const: 42 }, 42)).toBeNull();
  });

  it('注解关键字不影响判定；非对象 schema 放行（由调用方保证 shape）', () => {
    expect(validateAgainstSchema({ type: 'string', description: 'x', title: 'y' }, 'ok')).toBeNull();
    expect(validateAgainstSchema(null, { anything: true })).toBeNull();
    expect(validateAgainstSchema('not-schema', 1)).toBeNull();
  });
});

describe('collectUnsupportedKeywords（严格模式关键字白名单）', () => {
  it('检出顶层与嵌套（properties/items）子 schema 的子集外关键字', () => {
    const unsupported = collectUnsupportedKeywords({
      type: 'object',
      properties: {
        a: { type: 'string', anyOf: [{ type: 'string' }] },
        b: { type: 'object', properties: { c: { $ref: '#/definitions/x' } } }
      },
      oneOf: [{ type: 'object' }]
    });
    expect([...unsupported].sort()).toEqual(['$ref', 'anyOf', 'oneOf']);
  });

  it('注解关键字不算不支持', () => {
    expect(collectUnsupportedKeywords({ type: 'string', description: 'x', examples: ['y'], default: 'z' }).size).toBe(0);
  });
});
