/**
 * normalize.ts — Shared data normalization utilities.
 *
 * Centralizes all UID/phone cleaning logic so every ingestion point
 * (SDK sync, CSV upload, group extraction, campaign enqueue) produces
 * identical, DB-safe values. This prevents "phantom duplicates" caused
 * by trailing version suffixes, whitespace, or type mismatches.
 */

/**
 * Normalize a Zalo UID to a clean, consistent string.
 *
 * Handles the following real-world quirks:
 *   - SDK returns number instead of string           → String(uid)
 *   - `memVerList` entries have `_version` suffix     → split('_')[0]
 *   - Leading/trailing whitespace from CSV parsing    → trim()
 *   - null / undefined / empty                        → returns ''
 *
 * @example
 *   normalizeZaloUid('123456789_12')  // '123456789'
 *   normalizeZaloUid(123456789)       // '123456789'
 *   normalizeZaloUid('  uid  ')       // 'uid'
 *   normalizeZaloUid(null)            // ''
 */
export function normalizeZaloUid(uid: string | number | null | undefined): string {
  if (uid === null || uid === undefined) return '';
  return String(uid).trim().split('_')[0];
}

/**
 * Normalize text content to NFC (Unicode Canonical Decomposition + Composition).
 *
 * This is **critical** for @mention position/length accuracy:
 *   - Vietnamese diacritics can be stored as precomposed (NFC, 1 code unit: "á")
 *     or decomposed (NFD, 2 code units: "a" + combining accent "´").
 *   - Zalo and JavaScript's `.length` both count UTF-16 code units.
 *   - If the same string is NFC on one side and NFD on the other,
 *     `pos` / `len` offsets will silently drift → tags highlight wrong text.
 *
 * Call this function on **every** text boundary:
 *   - Before computing mention `pos` / `len` (frontend)
 *   - Before sending to zca-js (backend)
 *   - When persisting incoming messages to DB (listener)
 *
 * @example
 *   normalizeContent('Nguye\u0303n')  // → 'Nguyễn' (single precomposed char)
 *   normalizeContent(null)          // → ''
 */
export function normalizeContent(text: string | null | undefined): string {
  if (text === null || text === undefined) return '';
  return text.normalize('NFC');
}
