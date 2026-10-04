/**
 * 阶段 8：Skill 包发现（扫描 skillsRoot 下的目录，DEV_PLAN §5.8）。
 *
 * - 约定布局：`<skillsRoot>/<任意目录名>/skill.json`（目录名不必等于技能名，
 *   但同名技能（manifest.name 冲突）只认排序靠前的目录，其余报错可见）。
 * - 每个子目录产出一个 SkillEntry：合法 → manifest + 指纹；
 *   任何问题（skill.json 缺失/解析失败/entry 脚本缺失/重名）→ error 字段可见，
 *   **整包拒绝**，绝不部分加载。
 * - 指纹（fingerprint）= sha256(manifest 原文 + 各 entry 脚本原文)：
 *   启用时记录，启用期间内容一变即被识别为「内容已变更」→ 自动回禁用（供应链防篡改）。
 * - 本模块用 node 内建（fs/crypto/path），只从 @fairy/core 完整入口导出（不进 renderer）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { SKILL_MANIFEST_FILENAME, parseSkillManifest, SkillManifestError } from './manifest';
import type { SkillManifest } from './manifest';

/** 单个技能包的扫描结果（error 存在 = 整包拒绝，manifest 为 null） */
export interface SkillEntry {
  /** 技能包目录绝对路径 */
  dir: string;
  /** manifest.name（解析失败时为目录名，仅供定位展示） */
  name: string;
  manifest: SkillManifest | null;
  /** 内容指纹（sha256 hex；解析失败 = ''） */
  fingerprint: string;
  /** 可见错误（加载/校验失败原因；无错 = undefined） */
  error?: string;
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** entry 相对路径 → 绝对路径 + 边界校验（必须仍在 skillDir 内） */
export function resolveSkillEntryPath(skillDir: string, entry: string): string | null {
  const abs = resolve(skillDir, entry);
  const root = resolve(skillDir);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  if (!isAbsolute(abs)) return null;
  return abs;
}

/**
 * 扫描 skillsRoot（不存在则创建）下所有技能包。
 * 返回按目录名排序的结果；单包失败不阻断其他包（错误在 entry.error 可见）。
 */
export function discoverSkills(skillsRoot: string): SkillEntry[] {
  if (!existsSync(skillsRoot)) {
    try {
      mkdirSync(skillsRoot, { recursive: true });
    } catch {
      return []; // 目录不可建：视为无技能（调用方日志可见空列表）
    }
  }

  let dirs: string[];
  try {
    dirs = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() || (d.isSymbolicLink && d.isSymbolicLink()))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }

  const entries: SkillEntry[] = [];
  const seenNames = new Set<string>();

  for (const dirName of dirs) {
    const dir = join(skillsRoot, dirName);
    const manifestPath = join(dir, SKILL_MANIFEST_FILENAME);
    if (!existsSync(manifestPath)) {
      entries.push({ dir, name: dirName, manifest: null, fingerprint: '', error: `${SKILL_MANIFEST_FILENAME} 不存在` });
      continue;
    }

    let manifestRaw: string;
    try {
      manifestRaw = readFileSync(manifestPath, 'utf8');
    } catch (err) {
      entries.push({ dir, name: dirName, manifest: null, fingerprint: '', error: `读取 skill.json 失败：${(err as Error).message}` });
      continue;
    }

    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(manifestRaw);
    } catch (err) {
      entries.push({ dir, name: dirName, manifest: null, fingerprint: '', error: `skill.json 不是合法 JSON：${(err as Error).message}` });
      continue;
    }

    let manifest: SkillManifest;
    try {
      manifest = parseSkillManifest(parsedValue);
    } catch (err) {
      const reason = err instanceof SkillManifestError ? err.message : String(err);
      entries.push({ dir, name: dirName, manifest: null, fingerprint: '', error: `skill.json 校验失败：${reason}` });
      continue;
    }

    // 重名冲突：同 manifest.name 的多个目录，靠前者生效，其余整包拒绝
    if (seenNames.has(manifest.name)) {
      entries.push({ dir, name: manifest.name, manifest, fingerprint: '', error: `技能名重复（已被靠前的同名目录占用）：${manifest.name}` });
      continue;
    }

    // entry 脚本必须存在、是普通文件、且不逃出技能包目录（解析时已禁 ..，此处防 symlink/竞态）
    const hash = createHash('sha256').update(manifestRaw, 'utf8');
    let entryOk = true;
    for (const tool of manifest.tools) {
      const abs = resolveSkillEntryPath(dir, tool.entry);
      if (abs === null || !existsSync(abs)) {
        entries.push({ dir, name: manifest.name, manifest, fingerprint: '', error: `entry 脚本不存在或越界：${tool.entry}` });
        entryOk = false;
        break;
      }
      try {
        if (!statSync(abs).isFile()) throw new Error('不是普通文件');
        hash.update('\u0000').update(readFileSync(abs));
      } catch (err) {
        entries.push({ dir, name: manifest.name, manifest, fingerprint: '', error: `读取 entry 脚本失败：${tool.entry}（${(err as Error).message}）` });
        entryOk = false;
        break;
      }
    }
    if (!entryOk) continue;

    seenNames.add(manifest.name);
    entries.push({ dir, name: manifest.name, manifest, fingerprint: hash.digest('hex') });
  }

  return entries;
}
