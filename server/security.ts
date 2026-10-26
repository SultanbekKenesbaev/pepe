import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import type { User } from '../shared/types.js';

export const uid = () => randomBytes(16).toString('hex');
export const now = () => new Date().toISOString();
export const hashToken = (s: string) => createHash('sha256').update(s).digest('hex');
export function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
}
const dummyHash = passwordHash('dummy-password-never-used');
export function passwordMatches(password: string, hash?: string) {
  const [, salt, expected] = (hash || dummyHash).split('$');
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  const target = Buffer.from(expected, 'hex');
  return actual.length === target.length && timingSafeEqual(actual, target) && !!hash;
}
export function passwordValid(value: unknown) {
  return typeof value === 'string' && value.length >= 10 && value.length <= 200 && /[a-zа-я]/i.test(value) && /\d/.test(value);
}
export function totp(secret: string, email: string) {
  return new OTPAuth.TOTP({ issuer: 'AI Teacher', label: email, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });
}
export function validTotp(secret: string | null | undefined, code: unknown, email: string) {
  return !!secret && typeof code === 'string' && /^\d{6}$/.test(code) && totp(secret, email).validate({ token: code, window: 1 }) !== null;
}
export function newTotp(email: string) {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  return { secret, uri: totp(secret, email).toString() };
}
export function publicUser(row: any): User {
  return { ...row.data, id: row.id, institutionId: row.institution_id, email: row.email, mfaEnabled: !!row.mfa_secret };
}
export class ApiError extends Error {
  constructor(public status: number, message: string, public code = 'VALIDATION_ERROR') { super(message); }
}
export const requireCondition = (value: unknown, message: string, status = 400): asserts value => { if (!value) throw new ApiError(status, message); };
export const adminRoles = ['SUPER_ADMIN', 'ADMIN'];
export const teachingRoles = ['SUPER_ADMIN', 'ADMIN', 'TEACHER'];
