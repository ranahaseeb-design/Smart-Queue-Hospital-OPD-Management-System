'use strict';
/**
 * Small server-side input validation helpers (NFR-04). Each helper returns the
 * normalised value or throws a 400 VALIDATION_ERROR.
 */
const { badRequest } = require('./errors');
const time = require('./time');

const isMissing = (v) => v === undefined || v === null || v === '';

function int(value, name, { required = false, min, max } = {}) {
  if (isMissing(value)) {
    if (required) throw badRequest(`${name} is required`);
    return null;
  }
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(n)) throw badRequest(`${name} must be an integer`);
  if (min !== undefined && n < min) throw badRequest(`${name} must be >= ${min}`);
  if (max !== undefined && n > max) throw badRequest(`${name} must be <= ${max}`);
  return n;
}

function num(value, name, { required = false, min, max } = {}) {
  if (isMissing(value)) {
    if (required) throw badRequest(`${name} is required`);
    return null;
  }
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) throw badRequest(`${name} must be a number`);
  if (min !== undefined && n < min) throw badRequest(`${name} must be >= ${min}`);
  if (max !== undefined && n > max) throw badRequest(`${name} must be <= ${max}`);
  return n;
}

function str(value, name, { required = false, min = 0, max = 255, trim = true } = {}) {
  if (isMissing(value) || (typeof value === 'string' && trim && value.trim() === '')) {
    if (required) throw badRequest(`${name} is required`);
    return null;
  }
  if (typeof value !== 'string') throw badRequest(`${name} must be a string`);
  const s = trim ? value.trim() : value;
  if (s.length < min) throw badRequest(`${name} must be at least ${min} characters`);
  if (s.length > max) throw badRequest(`${name} must be at most ${max} characters`);
  return s;
}

function oneOf(value, name, allowed, { required = false } = {}) {
  if (isMissing(value)) {
    if (required) throw badRequest(`${name} is required`);
    return null;
  }
  const s = String(value).trim().toUpperCase();
  if (!allowed.includes(s)) throw badRequest(`${name} must be one of ${allowed.join(', ')}`);
  return s;
}

function bool(value, name, { required = false } = {}) {
  if (isMissing(value)) {
    if (required) throw badRequest(`${name} is required`);
    return null;
  }
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  throw badRequest(`${name} must be a boolean`);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function email(value, name = 'email', { required = false } = {}) {
  const s = str(value, name, { required, max: 120 });
  if (s === null) return null;
  if (!EMAIL_RE.test(s)) throw badRequest(`${name} is not a valid e-mail address`);
  return s.toLowerCase();
}

/** Pakistani-style or international phone: digits with optional leading +, 10-15 digits. */
function phone(value, name = 'phone', { required = false } = {}) {
  const s = str(value, name, { required, max: 20 });
  if (s === null) return null;
  const normalized = s.replace(/[\s-]/g, '');
  if (!/^\+?\d{10,15}$/.test(normalized)) throw badRequest(`${name} is not a valid phone number`);
  return normalized;
}

function date(value, name, { required = false } = {}) {
  if (isMissing(value)) {
    if (required) throw badRequest(`${name} is required`);
    return null;
  }
  const d = time.parseDate(String(value));
  if (!d) throw badRequest(`${name} must be a date in YYYY-MM-DD format`);
  return time.formatDate(d);
}

function dateTime(value, name, { required = false } = {}) {
  if (isMissing(value)) {
    if (required) throw badRequest(`${name} is required`);
    return null;
  }
  const d = time.parseDateTime(String(value));
  if (!d) throw badRequest(`${name} must be a datetime in YYYY-MM-DDTHH:mm:ss format`);
  return d;
}

function timeOfDay(value, name, { required = false } = {}) {
  if (isMissing(value)) {
    if (required) throw badRequest(`${name} is required`);
    return null;
  }
  const t = time.normalizeTime(String(value));
  if (!t) throw badRequest(`${name} must be a time in HH:mm format`);
  return t;
}

function password(value, name = 'password', { required = false } = {}) {
  if (isMissing(value)) {
    if (required) throw badRequest(`${name} is required`);
    return null;
  }
  if (typeof value !== 'string') throw badRequest(`${name} must be a string`);
  if (value.length < 6) throw badRequest(`${name} must be at least 6 characters`);
  if (value.length > 128) throw badRequest(`${name} must be at most 128 characters`);
  return value;
}

/** Route parameter id. */
function id(value, name = 'id') {
  return int(value, name, { required: true, min: 1 });
}

module.exports = { int, num, str, oneOf, bool, email, phone, date, dateTime, timeOfDay, password, id, isMissing };
