/**
 * Heuristic email -> structured change request normalizer.
 *
 * Deterministic, no LLM. Recognized patterns map to edit_type + payload.
 * Anything we can't classify becomes edit_type='unknown' with the raw text
 * preserved, and the issue gets a needs-clarification label downstream.
 *
 * v1 supported edit types (mirror migration CHECK):
 *   replace_text, replace_image, remove_image,
 *   update_phone, update_email, update_hours, update_address,
 *   add_content_item, remove_content_item, add_asset, unknown
 */

import type { EditType } from '../types';

export interface NormalizedRequest {
  edit_type: EditType;
  summary: string;
  payload: Record<string, unknown>;
}

export interface NormalizerInput {
  subject: string | null;
  text_body: string | null;
  has_attachments: boolean;
}

const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/;
const EMAIL_RE = /([\w.+-]+@[\w-]+\.[\w.-]+)/i;

/**
 * Returns the most plausible classification. Order is deliberate: more specific
 * intents win over generic "replace text".
 */
export function normalize(input: NormalizerInput): NormalizedRequest {
  const subject = (input.subject ?? '').trim();
  const text = (input.text_body ?? '').trim();
  const all = `${subject}\n${text}`;
  const lc = all.toLowerCase();

  // -------- update phone --------
  if (matches(lc, ['update phone', 'change phone', 'new phone number', 'phone number to'])) {
    const phone = (text.match(PHONE_RE) ?? subject.match(PHONE_RE))?.[1] ?? null;
    return {
      edit_type: 'update_phone',
      summary: phone ? `Update phone number to ${phone}` : 'Update phone number (value unspecified)',
      payload: { new_phone: phone, original_text: text || subject },
    };
  }

  // -------- update email --------
  if (matches(lc, ['update email', 'change email', 'new email address', 'contact email'])) {
    const email = (text.match(EMAIL_RE) ?? subject.match(EMAIL_RE))?.[1] ?? null;
    return {
      edit_type: 'update_email',
      summary: email ? `Update contact email to ${email}` : 'Update contact email (value unspecified)',
      payload: { new_email: email, original_text: text || subject },
    };
  }

  // -------- update hours --------
  if (matches(lc, ['business hours', 'opening hours', 'hours of operation', 'open hours', 'change hours'])) {
    return {
      edit_type: 'update_hours',
      summary: 'Update business hours',
      payload: { original_text: text || subject },
    };
  }

  // -------- update address --------
  if (matches(lc, ['new address', 'physical address', 'change address', 'update address', 'moving to', 'we moved'])) {
    return {
      edit_type: 'update_address',
      summary: 'Update physical address',
      payload: { original_text: text || subject },
    };
  }

  // -------- image ops --------
  if (matches(lc, ['remove image', 'delete image', 'take down photo', 'remove photo'])) {
    return {
      edit_type: 'remove_image',
      summary: 'Remove an image',
      payload: { original_text: text || subject },
    };
  }
  if (matches(lc, ['replace image', 'swap image', 'new image', 'replace photo', 'new photo'])) {
    return {
      edit_type: 'replace_image',
      summary: 'Replace an image',
      payload: { original_text: text || subject, has_attachments: input.has_attachments },
    };
  }

  // -------- structured content list ops --------
  if (matches(lc, ['add item', 'add a new item', 'add menu item', 'add product', 'add service'])) {
    return {
      edit_type: 'add_content_item',
      summary: 'Add a content item',
      payload: { original_text: text || subject },
    };
  }
  if (matches(lc, ['remove item', 'delete item', 'take down item', 'remove menu item'])) {
    return {
      edit_type: 'remove_content_item',
      summary: 'Remove a content item',
      payload: { original_text: text || subject },
    };
  }

  // -------- attachment-only -> add asset --------
  if (input.has_attachments && (matches(lc, ['add', 'upload', 'attach', 'put', 'pdf', 'flyer', 'menu']) || subject.length === 0)) {
    return {
      edit_type: 'add_asset',
      summary: subject ? `Add asset: ${subject}` : 'Add uploaded asset',
      payload: { original_text: text || subject, has_attachments: true },
    };
  }

  // -------- replace text fallback --------
  if (matches(lc, ['change text', 'update text', 'fix typo', 'rewrite', 'reword', 'replace'])) {
    return {
      edit_type: 'replace_text',
      summary: subject || 'Text update',
      payload: { original_text: text || subject },
    };
  }

  // -------- unknown --------
  return {
    edit_type: 'unknown',
    summary: subject || 'Unclassified change request',
    payload: { original_text: text || subject, has_attachments: input.has_attachments },
  };
}

function matches(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}
