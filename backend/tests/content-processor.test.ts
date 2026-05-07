/**
 * content-processor.test.ts — Unit tests for ContentProcessor (Spintax & Variable Substitution).
 *
 * Tests cover:
 *   - parseSpintax: single group, multiple groups, no-pipe passthrough, {{var}} safety
 *   - replaceVariables: basic substitution, fallback, case-insensitivity, whitespace tolerance
 *   - process: full pipeline combining both transforms
 */
import { describe, it, expect, vi } from 'vitest';
import { ContentProcessor, type ContactData } from '../src/shared/text-formatter.js';

// ── parseSpintax ────────────────────────────────────────────────────────────

describe('ContentProcessor.parseSpintax', () => {
  it('should resolve a single spintax group to one of its options', () => {
    const options = ['Chào', 'Hi', 'Xin chào'];
    const result = ContentProcessor.parseSpintax('{Chào|Hi|Xin chào} bạn');

    // The result must start with one of the options and end with " bạn"
    const picked = result.replace(' bạn', '');
    expect(options).toContain(picked);
  });

  it('should resolve multiple spintax groups independently', () => {
    // Run multiple times to verify both groups are resolved
    for (let i = 0; i < 20; i++) {
      const result = ContentProcessor.parseSpintax('{A|B} và {C|D}');
      expect(result).toMatch(/^(A|B) và (C|D)$/);
    }
  });

  it('should return text as-is when there are no spintax groups', () => {
    const text = 'Xin chào bạn, chúc bạn ngày mới tốt lành!';
    expect(ContentProcessor.parseSpintax(text)).toBe(text);
  });

  it('should NOT treat {{variable}} as spintax (double braces are safe)', () => {
    const text = '{{name}} ơi, {Chào|Hi} bạn!';
    const result = ContentProcessor.parseSpintax(text);

    // {{name}} must remain untouched
    expect(result).toContain('{{name}}');
    // The spintax group must be resolved
    expect(result).toMatch(/\{\{name\}\} ơi, (Chào|Hi) bạn!/);
  });

  it('should handle single-option braces (no pipe) — passthrough', () => {
    // {NoBraces} has no pipe, so the regex won't match it → passed through
    const text = 'Hello {World}';
    expect(ContentProcessor.parseSpintax(text)).toBe('Hello {World}');
  });

  it('should handle empty input', () => {
    expect(ContentProcessor.parseSpintax('')).toBe('');
  });

  it('should handle spintax with unicode/Vietnamese text', () => {
    const result = ContentProcessor.parseSpintax('{Xin chào|Chào buổi sáng|Kính chào}');
    expect(['Xin chào', 'Chào buổi sáng', 'Kính chào']).toContain(result);
  });
});

// ── replaceVariables ────────────────────────────────────────────────────────

describe('ContentProcessor.replaceVariables', () => {
  const contact: ContactData = {
    name: 'Nguyễn Văn A',
    phone: '0901234567',
    email: 'a@example.com',
  };

  it('should replace {{name}} and {{phone}} with contact data', () => {
    const text = 'Chào {{name}}, SĐT của bạn là {{phone}}.';
    const result = ContentProcessor.replaceVariables(text, contact);
    expect(result).toBe('Chào Nguyễn Văn A, SĐT của bạn là 0901234567.');
  });

  it('should use fallback for missing variables', () => {
    const text = 'Chào {{name}}, mã KH: {{customerId}}.';
    const result = ContentProcessor.replaceVariables(text, contact);
    expect(result).toBe('Chào Nguyễn Văn A, mã KH: bạn.');
  });

  it('should allow a custom fallback value', () => {
    const text = 'Chào {{nickname}}.';
    const result = ContentProcessor.replaceVariables(text, contact, 'Quý khách');
    expect(result).toBe('Chào Quý khách.');
  });

  it('should be case-insensitive for variable names', () => {
    const text = '{{Name}} — {{PHONE}} — {{Email}}';
    const result = ContentProcessor.replaceVariables(text, contact);
    expect(result).toBe('Nguyễn Văn A — 0901234567 — a@example.com');
  });

  it('should trim whitespace inside double braces', () => {
    const text = 'Chào {{ name }}, SĐT: {{  phone  }}.';
    const result = ContentProcessor.replaceVariables(text, contact);
    expect(result).toBe('Chào Nguyễn Văn A, SĐT: 0901234567.');
  });

  it('should use fallback for null values', () => {
    const contact: ContactData = { name: null, phone: '0901234567' };
    const text = 'Chào {{name}}, SĐT {{phone}}.';
    const result = ContentProcessor.replaceVariables(text, contact);
    expect(result).toBe('Chào bạn, SĐT 0901234567.');
  });

  it('should use fallback for empty string values', () => {
    const contact: ContactData = { name: '', phone: '0901234567' };
    const text = 'Chào {{name}}.';
    const result = ContentProcessor.replaceVariables(text, contact);
    expect(result).toBe('Chào bạn.');
  });

  it('should return text as-is when there are no variables', () => {
    const text = 'Xin chào bạn!';
    expect(ContentProcessor.replaceVariables(text, contact)).toBe(text);
  });
});

// ── process (full pipeline) ─────────────────────────────────────────────────

describe('ContentProcessor.process', () => {
  it('should resolve spintax first, then replace variables', () => {
    const template = '{Chào|Hi} {{name}}, {SĐT|Số điện thoại} của bạn là {{phone}}.';
    const contact: ContactData = { name: 'Lan', phone: '0909999999' };

    const result = ContentProcessor.process(template, contact);

    // Spintax resolved + variables replaced
    expect(result).toMatch(/^(Chào|Hi) Lan, (SĐT|Số điện thoại) của bạn là 0909999999\.$/);
  });

  it('should produce different outputs on multiple calls (randomness)', () => {
    const template = '{A|B|C|D|E} {{name}}';
    const contact: ContactData = { name: 'Test' };

    const results = new Set<string>();
    for (let i = 0; i < 50; i++) {
      results.add(ContentProcessor.process(template, contact));
    }

    // With 5 options and 50 iterations, we should see at least 2 different results
    expect(results.size).toBeGreaterThanOrEqual(2);
  });

  it('should handle template with no spintax and no variables', () => {
    const result = ContentProcessor.process('Tin nhắn thường', {});
    expect(result).toBe('Tin nhắn thường');
  });
});
