/**
 * Rider names are stored and later rendered in the portal and in emails.
 * Cap the length and keep control characters and markup out of the database.
 */

export const RIDER_NAME_MAX = 60;

const MARKUP_OR_CONTROL = /[\u0000-\u001F\u007F<>\u202A-\u202E\u2066-\u2069]/;

export function validateRiderName(value, { required = false, label = 'Name' } = {}) {
  if (value == null) return required ? `${label} is required` : null;
  if (typeof value !== 'string' && typeof value !== 'number') return `${label} must be text`;
  const trimmed = String(value).trim();
  if (!trimmed) return required ? `${label} is required` : null;
  if (trimmed.length > RIDER_NAME_MAX) return `${label} is too long`;
  if (MARKUP_OR_CONTROL.test(trimmed)) return `${label} contains characters that are not allowed`;
  return null;
}

/**
 * Provider display names and device headers are not a form the rider can fix
 * mid-request, so strip unsafe characters instead of failing the whole call.
 */
export function cleanRiderName(value, { fallback = '', max = RIDER_NAME_MAX } = {}) {
  let s = String(value ?? '');
  s = s.replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  s = s.replace(/<[^>]*>/g, '');
  s = s.replace(/[<>\u202A-\u202E\u2066-\u2069]/g, '');
  s = s.replace(/[\u0000-\u001F\u007F]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max).trim();
  return s || fallback;
}
