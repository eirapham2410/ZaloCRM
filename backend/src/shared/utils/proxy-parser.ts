/**
 * Proxy Parser Utility
 *
 * Parses a proxy URL string and returns the appropriate HTTP Agent
 * for use with zca-js SDK connections.
 *
 * Supported proxy formats:
 *   - http://user:pass@ip:port
 *   - https://user:pass@ip:port
 *   - socks4://user:pass@ip:port
 *   - socks5://user:pass@ip:port
 *   - socks://user:pass@ip:port  (alias for socks5)
 *
 * The returned Agent implements Node's http.Agent interface,
 * which is what zca-js accepts in its Options.agent field.
 */
import type { Agent } from 'http';

// ── Validation ─────────────────────────────────────────────────────────

/** Supported proxy URL schemes. */
const SUPPORTED_SCHEMES = ['http:', 'https:', 'socks4:', 'socks5:', 'socks:'];

/**
 * Validate whether a proxy URL string is well-formed and uses a
 * supported protocol.
 *
 * Returns `{ valid: true }` on success, or `{ valid: false, reason }` on failure.
 */
export function validateProxyUrl(proxyUrl: string): { valid: true } | { valid: false; reason: string } {
  if (!proxyUrl || proxyUrl.trim().length === 0) {
    return { valid: false, reason: 'Proxy URL không được để trống.' };
  }

  const trimmed = proxyUrl.trim();

  // Attempt to parse as a URL
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      valid: false,
      reason: 'Proxy URL không hợp lệ. Nếu username hoặc password có chứa ký tự đặc biệt (@, #, :), vui lòng chuyển sang URL Encoding (ví dụ: @ thành %40).',
    };
  }

  // Check protocol
  if (!SUPPORTED_SCHEMES.includes(parsed.protocol)) {
    return {
      valid: false,
      reason: `Giao thức "${parsed.protocol}" không được hỗ trợ. Chỉ hỗ trợ: http, https, socks4, socks5.`,
    };
  }

  // Must have a hostname
  if (!parsed.hostname) {
    return { valid: false, reason: 'Proxy URL phải có địa chỉ IP hoặc hostname.' };
  }

  // Must have a port
  if (!parsed.port) {
    return { valid: false, reason: 'Proxy URL phải có port. Ví dụ: http://ip:8080' };
  }

  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { valid: false, reason: `Port "${parsed.port}" không hợp lệ. Port phải từ 1 đến 65535.` };
  }

  return { valid: true };
}

// ── Agent creation ─────────────────────────────────────────────────────

/**
 * Create an appropriate proxy Agent from a proxy URL string.
 *
 * - Returns `undefined` when `proxyUrl` is `null`, `undefined`, or empty.
 * - Throws if the URL is malformed or uses an unsupported protocol.
 *
 * Usage:
 *   const agent = await createProxyAgent('socks5://user:pass@127.0.0.1:1080');
 *   const zalo = new Zalo({ ...opts, agent });
 */
export async function createProxyAgent(proxyUrl: string | null | undefined): Promise<Agent | undefined> {
  if (!proxyUrl || proxyUrl.trim().length === 0) {
    return undefined;
  }

  const trimmed = proxyUrl.trim();

  // Validate first
  const check = validateProxyUrl(trimmed);
  if (!check.valid) {
    throw new Error(`Invalid proxy URL: ${check.reason}`);
  }

  const parsed = new URL(trimmed);
  const protocol = parsed.protocol; // e.g. "http:", "socks5:"

  if (protocol === 'http:' || protocol === 'https:') {
    // Dynamic import to avoid loading when proxy is unused
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    return new HttpsProxyAgent(trimmed) as unknown as Agent;
  }

  if (protocol === 'socks:' || protocol === 'socks4:' || protocol === 'socks5:') {
    const { SocksProxyAgent } = await import('socks-proxy-agent');
    return new SocksProxyAgent(trimmed) as unknown as Agent;
  }

  // Should be unreachable after validation, but guard anyway
  throw new Error(`Unsupported proxy protocol: ${protocol}`);
}
