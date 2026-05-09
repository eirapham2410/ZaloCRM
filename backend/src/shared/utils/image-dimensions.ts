/**
 * image-dimensions.ts — Lightweight, zero-dependency image dimension reader.
 *
 * Parses raw Buffer headers to extract width and height for:
 *   - JPEG (.jpg, .jpeg)   — scans SOF markers (SOF0–SOF15)
 *   - PNG  (.png)           — IHDR chunk at bytes 16–23
 *   - WebP (.webp)          — VP8/VP8L/VP8X chunks
 *   - GIF  (.gif)           — Logical Screen Descriptor at bytes 6–9
 *
 * Falls back to { width: 0, height: 0 } if format is unrecognized.
 */

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Read image dimensions from a Buffer without any external library.
 * Supports JPEG, PNG, WebP, GIF.
 */
export function getImageDimensions(buffer: Buffer): ImageDimensions {
  if (!buffer || buffer.length < 8) {
    return { width: 0, height: 0 };
  }

  // ── PNG: starts with 0x89 50 4E 47 ───────────────────────────────────────
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return parsePng(buffer);
  }

  // ── JPEG: starts with 0xFF 0xD8 ──────────────────────────────────────────
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
    return parseJpeg(buffer);
  }

  // ── GIF: starts with GIF87a or GIF89a ────────────────────────────────────
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return parseGif(buffer);
  }

  // ── WebP: starts with RIFF....WEBP ───────────────────────────────────────
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return parseWebp(buffer);
  }

  return { width: 0, height: 0 };
}

// ── PNG Parser ──────────────────────────────────────────────────────────────
function parsePng(buffer: Buffer): ImageDimensions {
  // IHDR chunk: width at offset 16 (4 bytes BE), height at offset 20 (4 bytes BE)
  if (buffer.length < 24) return { width: 0, height: 0 };
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

// ── JPEG Parser ─────────────────────────────────────────────────────────────
function parseJpeg(buffer: Buffer): ImageDimensions {
  // Scan for SOF markers (0xFF 0xC0–0xCF, except 0xC4 and 0xCC)
  // SOF frame: [0xFF, 0xCn, length(2), precision(1), height(2), width(2)]
  let offset = 2; // Skip SOI marker (0xFF 0xD8)

  while (offset < buffer.length - 8) {
    if (buffer[offset] !== 0xFF) {
      offset++;
      continue;
    }

    const marker = buffer[offset + 1];

    // Skip filler bytes (0xFF 0xFF ...)
    if (marker === 0xFF) {
      offset++;
      continue;
    }

    // SOF markers: C0–CF except C4 (DHT) and CC (DAC)
    if (
      marker >= 0xC0 && marker <= 0xCF &&
      marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC
    ) {
      // offset+2 = length (2 bytes)
      // offset+4 = precision (1 byte)
      // offset+5 = height (2 bytes BE)
      // offset+7 = width (2 bytes BE)
      if (offset + 9 <= buffer.length) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
    }

    // Skip to next marker: marker + length field
    if (offset + 3 < buffer.length) {
      const segmentLength = buffer.readUInt16BE(offset + 2);
      offset += 2 + segmentLength;
    } else {
      break;
    }
  }

  return { width: 0, height: 0 };
}

// ── GIF Parser ──────────────────────────────────────────────────────────────
function parseGif(buffer: Buffer): ImageDimensions {
  // Logical Screen Descriptor at bytes 6–9 (width LE, height LE)
  if (buffer.length < 10) return { width: 0, height: 0 };
  return {
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8),
  };
}

// ── WebP Parser ─────────────────────────────────────────────────────────────
function parseWebp(buffer: Buffer): ImageDimensions {
  if (buffer.length < 30) return { width: 0, height: 0 };

  // Check VP8 type at offset 12
  const chunkType = buffer.toString('ascii', 12, 16);

  if (chunkType === 'VP8 ') {
    // Lossy VP8: width at offset 26–27 (LE, 14-bit), height at 28–29
    if (buffer.length < 30) return { width: 0, height: 0 };
    return {
      width: buffer.readUInt16LE(26) & 0x3FFF,
      height: buffer.readUInt16LE(28) & 0x3FFF,
    };
  }

  if (chunkType === 'VP8L') {
    // Lossless VP8L: signature byte at 21, then 4 bytes with width/height packed
    if (buffer.length < 25) return { width: 0, height: 0 };
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3FFF) + 1,
      height: ((bits >> 14) & 0x3FFF) + 1,
    };
  }

  if (chunkType === 'VP8X') {
    // Extended VP8X: canvas width at 24–26 (3 bytes LE), height at 27–29
    if (buffer.length < 30) return { width: 0, height: 0 };
    return {
      width: (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1,
      height: (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1,
    };
  }

  return { width: 0, height: 0 };
}
