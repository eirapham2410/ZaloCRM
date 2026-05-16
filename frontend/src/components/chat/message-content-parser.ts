// ── Parsed Content Interfaces ──────────────────────────────────────

export interface StickerContent {
  stickerUrl: string;
  stickerType?: string;
  width?: number;
  height?: number;
}

export interface VideoContent {
  videoUrl: string;
  thumbnailUrl?: string;
  duration?: number;
  fileSize?: number;
  caption?: string;
}

export interface FileContent {
  fileUrl: string;
  fileName: string;
  fileSize: number;
  extension: string;
}

export interface LinkContent {
  url: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  domain?: string;
}

export interface GifContent {
  gifUrl: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
}

// ── Utility Functions ─────────────────────────────────────────────

/**
 * Format bytes to human readable format (KB, MB, etc)
 */
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || isNaN(bytes)) return '0 B';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Helper to safely parse params which can sometimes be a stringified JSON
 */
function parseParams(paramsRaw: any): any {
  if (typeof paramsRaw === 'string') {
    try {
      return JSON.parse(paramsRaw);
    } catch {
      return {};
    }
  }
  return paramsRaw || {};
}

/**
 * Helper to safely extract domain from a URL
 */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// ── Parser Functions ──────────────────────────────────────────────

export function parseSticker(raw: string | null): StickerContent | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    const stickerUrl = data.href || data.thumb || '';
    return {
      stickerUrl: stickerUrl || raw,
      stickerType: data.type?.toString(),
      width: data.width,
      height: data.height,
    };
  } catch (err) {
    return { stickerUrl: raw };
  }
}

export function parseVideo(raw: string | null): VideoContent | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    const videoUrl = data.href || '';
    const params = parseParams(data.params);
    return {
      videoUrl: videoUrl || raw,
      thumbnailUrl: data.thumb,
      duration: params.duration ? Number(params.duration) : undefined,
      fileSize: params.fileSize ? Number(params.fileSize) : undefined,
      caption: data.title || data.description || data.desc,
    };
  } catch (err) {
    return { videoUrl: raw };
  }
}

export function parseFile(raw: string | null): FileContent | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    const params = parseParams(data.params);
    const fileUrl = data.href || '';
    const extension = params.fileExt || '';
    const fileName = data.title || params.fileName || `file.${extension || 'unknown'}`;
    const fileSize = params.fileSize ? Number(params.fileSize) : 0;
    
    return {
      fileUrl: fileUrl || raw,
      fileName,
      fileSize,
      extension,
    };
  } catch (err) {
    return {
      fileUrl: raw,
      fileName: 'Tệp đính kèm',
      fileSize: 0,
      extension: '',
    };
  }
}

export function parseLink(raw: string | null): LinkContent | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    const url = data.href || '';
    const targetUrl = url || raw;
    
    return {
      url: targetUrl,
      title: data.title,
      description: data.description || data.desc,
      imageUrl: data.thumb || data.hdUrl,
      domain: extractDomain(targetUrl),
    };
  } catch (err) {
    return { 
      url: raw,
      domain: extractDomain(raw),
    };
  }
}

export function parseGif(raw: string | null): GifContent | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    const gifUrl = data.href || data.thumb || '';
    return {
      gifUrl: gifUrl || raw,
      thumbnailUrl: data.thumb,
      width: data.width,
      height: data.height,
    };
  } catch (err) {
    return { gifUrl: raw };
  }
}
