/**
 * 阶段 10：URL 安全守卫（DEV_PLAN §5.10「资料来源范围」的执行边界）。
 *
 * LLM 输出与检索引擎返回均视为**不可信输入**，因此：
 * - 只允许 http/https（禁 file/ftp/data/javascript 等一切其他协议）；
 * - 禁止显式凭据（`user:pass@host`）——防止把内部凭据带出去；
 * - 禁止内网/本机/链路本地/云元数据地址（SSRF 防护）：
 *   localhost、127.0.0.0/8、10/8、172.16/12、192.168/16、169.254/16、
 *   100.64/10、0.0.0.0、::1、fc00::/7、fe80::/10，以及 `.local/.internal` 后缀；
 * - 端口只放行默认（HTTP 80 / HTTPS 443 与缺省），避免探测内网服务。
 *
 * **残余风险（如实声明）**：不做 DNS 预解析，DNS rebinding 与域前置类攻击不在本层防线内；
 * 与阶段 7 shell 的白名单同理，本守卫是「明显有害必拦」，不是 OS 级网络隔离。
 */

/** URL 校验结果：false = 该 URL 不该被访问（调用方直接丢弃/拒绝，不进审批） */
export interface UrlCheck {
  ok: boolean;
  /** 归一后的绝对 URL（可安全用于 fetch 与展示） */
  url?: string;
  reason?: string;
}

/** 端口白名单：缺省 / 80 / 443（其余一律拒绝） */
const ALLOWED_PORTS = new Set(['', '80', '443']);

/** 域名黑名单后缀（内网/本机命名惯例） */
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** IPv4 私有/保留网段判定（返回 true = 禁止访问） */
function isBlockedIpv4(host: string): boolean {
  const parts = host.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false; // 非法点分十进制：交给 URL 解析层处理
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // 0.0.0.0/8 · 10/8 · 回环
  if (a === 169 && b === 254) return true; // 链路本地（含 169.254.169.254 元数据）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a >= 224) return true; // 组播/保留/广播
  return false;
}

/**
 * IPv6 保留地址判定。
 * 注意：WHATWG URL 的 `hostname` 对 IPv6 **保留方括号**（形如 `[fc00::1]`），
 * 因此这里先剥括号再判段。
 */
function isBlockedIpv6(host: string): boolean {
  const raw = host.toLowerCase().trim();
  const h = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // fc00::/7 唯一本地
  if (h.startsWith('fe80')) return true; // 链路本地

  const groups = ipv6Groups(h);
  // 无法解析成一组合法 IPv6 组 → 按「无法证明安全」拒绝（URL 解析器已做过规范化，
  // 走到这里的畸形形态基本来自刻意构造）
  if (groups === null) return true;

  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  // IPv4 映射地址 ::ffff:a.b.c.d（WHATWG 规范会把它规范化成 ::ffff:7f00:1）
  const isIpv4Mapped =
    g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff;
  if (isIpv4Mapped) {
    return isBlockedIpv4(`${(g6 ?? 0) >> 8}.${(g6 ?? 0) & 0xff}.${(g7 ?? 0) >> 8}.${(g7 ?? 0) & 0xff}`);
  }
  return false;
}

/**
 * 把 IPv6 地址展开为 8 个 16 位组（支持 `::` 压缩与尾部 IPv4 点分写法）。
 * 无法解析或组数不对返回 null。
 */
function ipv6Groups(host: string): number[] | null {
  let text = host;
  // 尾部 IPv4 写法（如 ::ffff:127.0.0.1）：先把点分段折成两个 16 位组
  const v4Tail = text.match(/^(.*:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4Tail) {
    const parts = (v4Tail[2] ?? '').split('.').map((p) => Number.parseInt(p, 10));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const high = ((parts[0] ?? 0) << 8) | (parts[1] ?? 0);
    const low = ((parts[2] ?? 0) << 8) | (parts[3] ?? 0);
    text = `${v4Tail[1] ?? ''}${high.toString(16)}:${low.toString(16)}`;
  }

  const parseSide = (side: string): number[] | null => {
    if (side === '') return [];
    const out: number[] = [];
    for (const part of side.split(':')) {
      const n = Number.parseInt(part, 16);
      if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
      out.push(n);
    }
    return out;
  };

  const sides = text.split('::');
  if (sides.length === 1) {
    const groups = parseSide(text);
    return groups !== null && groups.length === 8 ? groups : null;
  }
  if (sides.length !== 2) return null;
  const head = parseSide(sides[0] ?? '');
  const tail = parseSide(sides[1] ?? '');
  if (head === null || tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null; // `::` 至少补一个零组，否则形态非法
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/**
 * 主机名是否为禁止访问的内网/本机目标。
 * 裸主机名（非 IP 字面量）只按命名惯例拦截，其余放行。
 */
export function isBlockedHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (h === '') return true;
  if (h === 'localhost') return true;
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (h.endsWith(suffix)) return true;
  }
  if (isIpv4(h)) return isBlockedIpv4(h);
  if (h.includes(':')) return isBlockedIpv6(h);
  return false;
}

/**
 * 校验一个将要被访问/展示的 URL。
 *
 * @param raw 原始字符串（可能来自模型或搜索结果）
 * @param opts.allowHttp 是否放行明文 http（默认 true：抓取外部页面时常见 https，
 *                       但少数站点仍为 http；若调用方要求严格可传 false）
 */
export function checkWebUrl(raw: string, opts: { allowHttp?: boolean } = {}): UrlCheck {
  const allowHttp = opts.allowHttp !== false;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, reason: 'URL 为空' };
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: `无法解析 URL：${raw}` };
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    return { ok: false, reason: `不支持的协议（仅允许 ${allowHttp ? 'http/https' : 'https'}）：${url.protocol}` };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'URL 不允许携带凭据' };
  }
  if (isBlockedHost(url.hostname)) {
    return { ok: false, reason: `目标主机在内网/本机禁止清单内：${url.hostname}` };
  }
  const port = url.port === '0' ? '' : url.port;
  if (!ALLOWED_PORTS.has(port)) {
    return { ok: false, reason: `端口不在放行范围（仅 80/443）：${url.port}` };
  }
  return { ok: true, url: url.toString() };
}

/**
 * 搜索结果里的链接归一（可能带引擎跳转包装、协议相对 `//`、相对路径）。
 * 返回归一后的绝对 URL 字符串；无法解析返回 undefined（调用方丢弃该条）。
 */
export function normalizeResultUrl(href: string, baseUrl: string): string | undefined {
  if (typeof href !== 'string' || href.trim() === '') return undefined;
  let raw = href.trim();
  // 引擎跳转包装：//duckduckgo.com/l/?uddg=<encoded> → 取真实目标
  if (raw.includes('uddg=')) {
    const q = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
    for (const pair of q.split('&')) {
      const [key, value] = pair.split('=');
      if (key === 'uddg' && value !== undefined) {
        try {
          raw = decodeURIComponent(value);
        } catch {
          return undefined;
        }
        break;
      }
    }
  }
  if (raw.startsWith('//')) raw = `https:${raw}`;
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return undefined;
  }
}

/** URL 去重键：忽略协议差异、hash、尾部斜杠与常见跟踪参数 */
export function urlDedupeKey(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.replace(/\/+$/, '');
    const params = [...u.searchParams.entries()]
      .filter(([k]) => !/^(utm_|ref$|ref_|source$|from$|spm$|fbclid$|gclid$)/.test(k))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    return `${host}${path}${params !== '' ? `?${params}` : ''}`;
  } catch {
    return url.toLowerCase();
  }
}

/** 取主机名（小写）；解析失败返回空串 */
export function urlHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 域名后缀匹配（用于白/黑名单）：`example.com` 命中 `example.com` 与 `a.example.com`，
 * 不命中 `notexample.com`。
 */
export function domainMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const d = domain.trim().toLowerCase().replace(/^\./, '').replace(/\.$/, '');
  if (d === '' || h === '') return false;
  return h === d || h.endsWith(`.${d}`);
}
