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
