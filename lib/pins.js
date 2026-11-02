'use strict';
/**
 * PIN hashing for schools. A PIN is a low-entropy secret, so it is stored only as a salted scrypt hash
 * and compared in constant time. Guessing is limited separately by the rate limiter in server.js.
 */
const crypto = require('crypto');

const MIN_LEN = 6, MAX_LEN = 40;

function checkPinFormat(pin) {
  const p = String(pin == null ? '' : pin);
  if (p.length < MIN_LEN) return `The PIN must be at least ${MIN_LEN} characters.`;
  if (p.length > MAX_LEN) return `The PIN can be at most ${MAX_LEN} characters.`;
  return null;
}

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return { salt, hash };
}

function verifyPin(pin, salt, hash) {
  if (!pin || !salt || !hash) return false;
  const got = crypto.scryptSync(String(pin), salt, 32);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

module.exports = { checkPinFormat, hashPin, verifyPin, MIN_LEN, MAX_LEN };
