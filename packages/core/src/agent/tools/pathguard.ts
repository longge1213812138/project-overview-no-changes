/**
 * 阶段 7：工作区路径边界守卫（DEV_PLAN §5.7/§6，内置工具共用）。
 *
 * - LLM 输出视为不可信输入：把原始路径字符串解析成「绝对真实路径」并判定内外；
 *   无法证明安全的形态（空串、控制字符、UNC/设备路径、盘符相对路径、
 *   环境变量展开语法）一律返回 ok:false，由调用方直接 deny（不进入审批）。
 * - 解析链路：相对路径按 workspaceRoot 解析，path.resolve 归一化（.. 自然处理）
 *   → 对最长存在祖先做 fs.realpathSync.native（解析符号链接/junction）
 *   → 把尚不存在的尾部拼回（写入场景目标可以不存在）。
 * - 内外比较采用 win32 语义：大小写不敏感、分隔符归一、且必须满足路径末尾
 *   分隔符边界（防止 workspace-evil 借前缀冒充 workspace）。
 * 转义自检标记：back\slash（本行仅用于验证文件写入未被转义破坏）。
 * 本模块为纯函数 + fs.realpath，无副作用、无新依赖、全平台可编译。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 路径解析与内外判定结果 */
export interface PathCheck {
  /** false = 路径本身不安全/不可解析（拒绝，不进审批） */
  ok: boolean;
  /** 解析后的绝对真实路径（realpath 解析符号链接/junction 后） */
  resolved?: string;
  /** 在工作区外（调用方决定 ask/deny） */
  outside?: boolean;
  /** ok=false 时的可读原因 */
  reason?: string;
}

/**
 * 字符码常量：源码内不写字面反斜杠/转义序列，
 * 避免任何中间传输层的转义处理破坏源码。
 */
const CODE_BACKSLASH = 92; // 反斜杠
const CODE_SLASH = 47; // 正斜杠
const CODE_COLON = 58; // 冒号
const CODE_DOLLAR = 36; // 美元符
const CODE_QUESTION = 63; // 问号
const CODE_DEL = 127; // DEL 控制字符

function isAsciiLetter(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z');
}

/** 控制字符（含 NUL）：任何位置出现都视为不可信 */
function isControlCode(code: number): boolean {
  return code < 32 || code === CODE_DEL;
}

/** UNC（双反斜杠/双正斜杠）与设备路径前缀 */
function hasDoubleSeparatorPrefix(s: string): boolean {
  if (s.length < 2) return false;
  const a = s.charCodeAt(0);
  const b = s.charCodeAt(1);
  return (
    (a === CODE_BACKSLASH && b === CODE_BACKSLASH) || (a === CODE_SLASH && b === CODE_SLASH)
  );
}

/**
 * 扩展/设备长路径前缀（反斜杠或正斜杠形式的问号变体）先行剥除，
 * 剥除后继续走常规校验（如盘符绝对路径 → 常规内外判定）。
 */
function stripExtendedPrefix(s: string): string {
  if (s.length < 4 || s.charCodeAt(2) !== CODE_QUESTION) return s;
  const a = s.charCodeAt(0);
  const b = s.charCodeAt(1);
  const d = s.charCodeAt(3);
  const extended = (a === CODE_BACKSLASH || a === CODE_SLASH) && b === a && d === a;
  return extended ? s.slice(4) : s;
}

/** 是否带盘符前缀（如 C 盘，与后面字符无关） */
function hasDrivePrefix(s: string): boolean {
  return s.length >= 2 && isAsciiLetter(s.charAt(0)) && s.charCodeAt(1) === CODE_COLON;
}

/** 盘符绝对路径 = 盘符 + 分隔符；缺分隔符即盘符相对路径（C:foo，拒绝） */
function isDriveAbsolute(s: string): boolean {
  if (!hasDrivePrefix(s) || s.length < 3) return false;
  const c = s.charCodeAt(2);
  return c === CODE_BACKSLASH || c === CODE_SLASH;
}

/** 展开语法：美元符后紧跟左花括号或标识符起始字符（${VAR} / $VAR） */
function hasDollarExpansion(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) !== CODE_DOLLAR) continue;
    const next = s.charAt(i + 1);
    if (next === '') continue;
    if (next === '{') return true;
    if (next === '_' || isAsciiLetter(next)) return true;
  }
  return false;
}

/** 最长存在祖先 realpath：从整条路径向上逐级尝试，成功后把未存在的尾部带回 */
function realpathDeepest(abs: string): { real: string; missing: string[] } {
  const missing: string[] = [];
  let current = abs;
  for (;;) {
    try {
      return { real: fs.realpathSync.native(current), missing: missing.reverse() };
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // 一路失败到盘符根（理论上不应发生）：原样返回，交由内外比较兜底
        return { real: abs, missing: [] };
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** 目录存在则解析真实路径，否则原样返回（工作区本身可能尚未创建） */
function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/** 比较用归一：剥扩展前缀、分隔符统一为反斜杠、小写（win32 大小写不敏感） */
function normalizeForCompare(p: string): string {
  let s = stripExtendedPrefix(p);
  if (s.includes('/')) {
    s = s.split('/').join(String.fromCharCode(CODE_BACKSLASH));
  }
  s = s.toLowerCase();
  // 去掉尾部分隔符（保留盘符根，其长度为 3）
  while (s.length > 3 && s.charCodeAt(s.length - 1) === CODE_BACKSLASH) {
    s = s.slice(0, -1);
  }
  return s;
}

/** 内外判定（入参均为归一化结果）：相等或落在根的分隔符边界内才算工作区内 */
function isInside(rootNorm: string, targetNorm: string): boolean {
  if (targetNorm === rootNorm) return true;
  const sep = String.fromCharCode(CODE_BACKSLASH);
  const endsWithSep = rootNorm.charCodeAt(rootNorm.length - 1) === CODE_BACKSLASH;
  return targetNorm.startsWith(endsWithSep ? rootNorm : rootNorm + sep);
}

/**
 * 把 LLM 给出的路径解析为绝对真实路径并判定是否在工作区内。
 *
 * 规则：空串/控制字符、UNC/设备路径、盘符相对路径、展开语法 → ok:false；
 * 相对路径按 workspaceRoot 解析；realpath 解析链接后比较，
 * 在工作区内 → {ok:true,outside:false,resolved}，否则 → {ok:true,outside:true,resolved}。
 */
export function resolveWorkspacePath(workspaceRoot: string, input: string): PathCheck {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') {
    return { ok: false, reason: '工作区根目录未配置' };
  }
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, reason: '路径为空' };
  }
  for (let i = 0; i < input.length; i++) {
    if (isControlCode(input.charCodeAt(i))) {
      return { ok: false, reason: '路径包含控制字符' };
    }
  }

  let candidate = stripExtendedPrefix(input);
  if (candidate === '') {
    return { ok: false, reason: '路径为空' };
  }
  if (hasDoubleSeparatorPrefix(candidate)) {
    return { ok: false, reason: '不支持 UNC/设备路径' };
  }
  if (hasDrivePrefix(candidate) && !isDriveAbsolute(candidate)) {
    return { ok: false, reason: '不支持盘符相对路径' };
  }
  // 含百分号即拒绝：%VAR% 展开与字面百分号无法可靠区分，保守处理（不提供展开层）
  if (candidate.includes('%') || hasDollarExpansion(candidate)) {
    return { ok: false, reason: '不支持环境变量展开语法' };
  }

  const realRoot = realpathOrSelf(path.resolve(workspaceRoot));

  let relative = candidate;
  const first = relative.charCodeAt(0);
  if (first === CODE_BACKSLASH || first === CODE_SLASH) {
    // 盘符缺失的根相对路径（例如 shell 参数里的 /i 旗标）按工作区根解析：
    // 既不会落到盘符根造成误判越界，实际访问也只会落在解析结果上。
    let start = 0;
    while (
      start < relative.length &&
      (relative.charCodeAt(start) === CODE_BACKSLASH || relative.charCodeAt(start) === CODE_SLASH)
    ) {
      start++;
    }
    relative = relative.slice(start);
    if (relative === '') {
      return { ok: false, reason: '仅根分隔符的路径无法安全解析' };
    }
  }

  const abs = path.resolve(realRoot, relative);
  const { real, missing } = realpathDeepest(abs);
  const resolved = missing.length > 0 ? path.join(real, ...missing) : real;
  const outside = !isInside(normalizeForCompare(realRoot), normalizeForCompare(resolved));
  return outside
    ? { ok: true, outside: true, resolved }
    : { ok: true, outside: false, resolved };
}
