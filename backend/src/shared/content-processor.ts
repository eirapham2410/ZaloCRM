/**
 * content-processor.ts — Bulk Campaign Message Rendering
 *
 * Dedicated entry point for campaign content personalization.
 * Re-exports and extends the ContentProcessor from text-formatter.ts,
 * adding a standalone `renderMessage()` function optimized for
 * campaign workers (no Zalo style parsing overhead).
 *
 * Pipeline (in order):
 *   1. Spintax  — `{Chào|Hi|Hello}` → random pick (anti-spam variation)
 *   2. Variables — `{{name}}`, `{{phone}}` → contact field substitution
 *
 * Usage:
 *   import { renderMessage } from '../shared/content-processor.js';
 *
 *   const text = renderMessage(
 *     '{Chào|Hi} {{name}}, SĐT: {{phone}}',
 *     { name: 'An', phone: '0901234567' }
 *   );
 *   // → "Chào An, SĐT: 0901234567"  (or "Hi An, …" — random)
 */

export {
  ContentProcessor,
  type ContactData,
} from './text-formatter.js';

import { ContentProcessor, type ContactData } from './text-formatter.js';

// ---------------------------------------------------------------------------
// Standalone render helper — primary API for campaign workers
// ---------------------------------------------------------------------------

/**
 * Render a campaign message template for a specific recipient.
 *
 * Steps:
 *  1. **Spintax expansion** — `{A|B|C}` → one random variant
 *  2. **Variable substitution** — `{{name}}`, `{{phone}}`, any `{{key}}` from `contact`
 *
 * Supported variable names (case-insensitive, diacritics stripped):
 *  - `{{name}}` / `{{ho_ten}}` — recipient's full name
 *  - `{{phone}}` — cleaned phone number (0901234567 format)
 *  - `{{email}}`
 *  - Any custom field from `contact.metadata` passed as flat keys
 *
 * @param template  Raw template string, e.g. `{Chào|Hi} {{name}}!`
 * @param contact   Recipient contact data (name, phone, email, …)
 * @param fallback  Value used when a variable has no data (default: `"bạn"`)
 * @returns         Fully personalized, unique string ready to send
 *
 * @example
 * renderMessage('{Xin chào|Chào} {{name}}!', { name: 'Lan' })
 * // → "Xin chào Lan!" or "Chào Lan!"
 *
 * @example — missing variable falls back
 * renderMessage('Gửi {{name}}', {})
 * // → "Gửi bạn"
 */
export function renderMessage(
  template: string,
  contact: ContactData,
  fallback = 'bạn',
): string {
  return ContentProcessor.process(template, contact, fallback);
}

/**
 * Render an `inviteMessage` for ADD_FRIEND campaigns.
 * Identical to `renderMessage` but semantically scoped to friend invites.
 *
 * @param inviteMessage  Raw invite template, e.g. `{Chào|Hi} {{name}}, mình là …`
 * @param contact        Recipient contact data
 */
export function renderInviteMessage(
  inviteMessage: string,
  contact: ContactData,
  fallback = 'bạn',
): string {
  return ContentProcessor.process(inviteMessage, contact, fallback);
}
