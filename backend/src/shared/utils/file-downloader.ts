/**
 * file-downloader.ts — Safe media download utility for Campaign Worker.
 *
 * Handles two source types:
 *   A. HTTP/HTTPS URL  → fetch into Buffer (with timeout + Memory Guard)
 *   B. Local file path → fs.readFile into Buffer (relative paths resolved from cwd)
 *
 * Safety features:
 *   - Memory Guard: reject files > 25 MB before/after download
 *   - Robust filename extraction via node:path (not string splitting)
 *   - Timeout: 60s abort for HTTP downloads
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from './logger.js';

// ── Constants ───────────────────────────────────────────────────────────────
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB — Zalo's practical limit
const DOWNLOAD_TIMEOUT_MS = 60_000;     // 60 seconds
const TAG = '[file-downloader]';

// ── Types ───────────────────────────────────────────────────────────────────
export interface DownloadedMedia {
  /** Extracted or generated filename (e.g. "report.pdf") */
  filename: string;
  /** File content as a Node.js Buffer */
  data: Buffer;
  /** File size in bytes */
  size: number;
}

// ── MIME → extension fallback map ───────────────────────────────────────────
const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/zip': 'zip',
  'application/x-rar-compressed': 'rar',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'text/plain': 'txt',
  'text/csv': 'csv',
};

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Load a file into memory from either an HTTP URL or a local file path.
 *
 * @param sourcePath - HTTP(S) URL or local/relative file path
 * @returns DownloadedMedia with filename, Buffer data, and size
 * @throws Error if file exceeds 25MB, source is unreachable, or read fails
 */
export async function downloadMediaToBuffer(sourcePath: string): Promise<DownloadedMedia> {
  if (!sourcePath || typeof sourcePath !== 'string') {
    throw new Error(`${TAG} Invalid source path: ${String(sourcePath)}`);
  }

  const isHttpUrl = sourcePath.startsWith('http://') || sourcePath.startsWith('https://');

  if (isHttpUrl) {
    return downloadFromUrl(sourcePath);
  } else {
    return readLocalFile(sourcePath);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGY A: HTTP/HTTPS URL
// ═══════════════════════════════════════════════════════════════════════════

async function downloadFromUrl(url: string): Promise<DownloadedMedia> {
  logger.debug(`${TAG} Fetching URL: ${url.slice(0, 120)}...`);

  // ── 1. Fetch with AbortController timeout ─────────────────────────────
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  // FIX: Network Loopback in Docker
  // If the frontend generated a URL with localhost/127.0.0.1 for MinIO public access,
  // the worker (inside Docker) must rewrite it to 'minio' to hit the internal container.
  let fetchUrl = url;
  if (process.env.NODE_ENV === 'production' || process.env.DOCKER_ENV === 'true') {
    fetchUrl = fetchUrl.replace('localhost:9000', 'minio:9000')
                       .replace('127.0.0.1:9000', 'minio:9000');
  }

  let response: Response;
  try {
    response = await fetch(fetchUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'ZaloCRM/1.0' },
    });
  } catch (err: any) {
    clearTimeout(timeout);
    throw new Error(`${TAG} Failed to fetch ${fetchUrl.slice(0, 80)}: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`${TAG} HTTP ${response.status} for ${url.slice(0, 80)}`);
  }

  // ── 2. Memory Guard: pre-download size check ──────────────────────────
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const declaredSize = parseInt(contentLength, 10);
    if (declaredSize > MAX_FILE_SIZE) {
      await response.body?.cancel().catch(() => {});
      throw new Error(
        `${TAG} File too large (${(declaredSize / 1024 / 1024).toFixed(1)}MB). ` +
        `Maximum: ${MAX_FILE_SIZE / 1024 / 1024}MB`,
      );
    }
  }

  // ── 3. Download body into Buffer ──────────────────────────────────────
  const arrayBuffer = await response.arrayBuffer();
  const data = Buffer.from(arrayBuffer);

  // Post-download guard (server may omit Content-Length)
  if (data.length > MAX_FILE_SIZE) {
    throw new Error(
      `${TAG} Downloaded file too large (${(data.length / 1024 / 1024).toFixed(1)}MB). ` +
      `Maximum: ${MAX_FILE_SIZE / 1024 / 1024}MB`,
    );
  }

  // ── 4. Extract filename (Content-Disposition → URL path → UUID) ───────
  const contentDisposition = response.headers.get('content-disposition') || '';
  const contentType = response.headers.get('content-type') || '';

  let filename = extractFromContentDisposition(contentDisposition);

  if (!filename) {
    filename = extractFromUrlPath(url);
  }

  if (!filename) {
    filename = generateFallbackFilename(contentType);
  }

  // Ensure extension exists; if missing, infer from Content-Type
  filename = ensureExtension(filename, contentType);

  logger.debug(`${TAG} Downloaded "${filename}" (${(data.length / 1024).toFixed(1)} KB)`);
  return { filename: sanitize(filename), data, size: data.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGY B: LOCAL FILE (relative or absolute path)
// ═══════════════════════════════════════════════════════════════════════════

async function readLocalFile(sourcePath: string): Promise<DownloadedMedia> {
  // Resolve relative paths from the process working directory (Docker: /app)
  const absolutePath = path.isAbsolute(sourcePath)
    ? sourcePath
    : path.resolve(process.cwd(), sourcePath);

  logger.debug(`${TAG} Reading local file: ${absolutePath}`);

  // ── 1. Check file exists and size ─────────────────────────────────────
  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(absolutePath);
  } catch (err: any) {
    throw new Error(`${TAG} Local file not found: ${absolutePath} (${err.code || err.message})`);
  }

  if (stats.size > MAX_FILE_SIZE) {
    throw new Error(
      `${TAG} Local file too large (${(stats.size / 1024 / 1024).toFixed(1)}MB). ` +
      `Maximum: ${MAX_FILE_SIZE / 1024 / 1024}MB`,
    );
  }

  // ── 2. Read file into Buffer ──────────────────────────────────────────
  const data = await fs.readFile(absolutePath);

  // ── 3. Extract filename using path.basename (always correct) ──────────
  const filename = path.basename(absolutePath);

  logger.debug(`${TAG} Read local "${filename}" (${(data.length / 1024).toFixed(1)} KB)`);
  return { filename: sanitize(filename), data, size: data.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// FILENAME EXTRACTION HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Priority 1: Parse Content-Disposition header (RFC 6266).
 * Supports both `filename*=UTF-8''encoded` and `filename="quoted"` forms.
 */
function extractFromContentDisposition(header: string): string | null {
  if (!header) return null;

  // Try RFC 5987 encoded form: filename*=UTF-8''My%20Report.pdf
  const encodedMatch = header.match(/filename\*=(?:UTF-8''|utf-8'')([^;\n]+)/i);
  if (encodedMatch?.[1]) {
    try {
      const decoded = decodeURIComponent(encodedMatch[1].trim());
      if (decoded && path.extname(decoded)) return decoded;
    } catch { /* fall through */ }
  }

  // Try quoted form: filename="My Report.pdf"
  const quotedMatch = header.match(/filename="(.+?)"/i);
  if (quotedMatch?.[1] && path.extname(quotedMatch[1])) {
    return quotedMatch[1];
  }

  // Try unquoted form: filename=report.pdf
  const unquotedMatch = header.match(/filename=([^\s;]+)/i);
  if (unquotedMatch?.[1] && path.extname(unquotedMatch[1])) {
    return unquotedMatch[1].replace(/['"]/g, '');
  }

  return null;
}

/**
 * Priority 2: Extract filename from URL pathname.
 * Uses URL class to strip query params, then path.basename for the last segment.
 */
function extractFromUrlPath(url: string): string | null {
  try {
    const parsed = new URL(url);
    // path.basename correctly handles "/uploads/report.pdf" → "report.pdf"
    const basename = path.basename(parsed.pathname);

    // Decode URI-encoded characters (e.g. %20 → space)
    const decoded = decodeURIComponent(basename);

    // Only return if the basename has a real extension
    if (decoded && path.extname(decoded).length >= 2) {
      return decoded;
    }
  } catch { /* invalid URL — fall through */ }

  return null;
}

/**
 * Priority 3: Generate a UUID-based filename with MIME-inferred extension.
 */
function generateFallbackFilename(contentType: string): string {
  const mimeBase = contentType.split(';')[0].trim().toLowerCase();
  const ext = MIME_TO_EXT[mimeBase] || 'bin';
  return `${randomUUID().slice(0, 8)}.${ext}`;
}

/**
 * Ensure filename has an extension. If missing, infer from Content-Type.
 * Prevents the ".j" bug (truncated extension from naive string splitting).
 */
function ensureExtension(filename: string, contentType: string): string {
  const ext = path.extname(filename); // e.g. ".pdf", ".jpg", "" (empty if no ext)

  if (ext && ext.length >= 2) {
    // Already has a valid extension
    return filename;
  }

  // No extension or truncated — infer from MIME
  const mimeBase = contentType.split(';')[0].trim().toLowerCase();
  const inferredExt = MIME_TO_EXT[mimeBase];
  if (inferredExt) {
    return `${filename}.${inferredExt}`;
  }

  // Last resort: append .bin
  return `${filename}.bin`;
}

/** Remove dangerous characters from filenames (path separators, null bytes) */
function sanitize(name: string): string {
  return name.replace(/[/\\:\0]/g, '_').trim() || 'unnamed.bin';
}
