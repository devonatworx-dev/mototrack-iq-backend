import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { createRider, getRiderByEmail, getRiderById, getRiderByVerifyToken, updateRider } from '../lib/db.js';
import { sendVerifyEmail, sendPasswordResetEmail } from '../lib/email.js';
import { requireAuth } from '../lib/middleware/auth.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || '<REDACTED-JWT-LITERAL>';

function signToken(riderId) { return jwt.sign({ riderId }, JWT_SECRET, { expiresIn: '30d' }); }
function sanitize(rider) { const { passwordHash, verifyToken, verifyTokenExpiry, resetToken, resetTokenExpiry, ...s } = rider; return s; }

function isStrongPassword(pwd) {
  if (!pwd || pwd.length < 8) return false;
  if (!/[A-Z]/.test(pwd)) return false;
  if (!/[a-z]/.test(pwd)) return false;
  if (!/[0-9]/.test(pwd)) return false;
  return true;
}

const VERIFY_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

function normEmail(e) { return String(e || '').trim().toLowerCase(); }

// ── Register (verification-first) ────────────────────────────────────────────
// Creates a PENDING rider (no password yet), sends a verification email.
// No JWT is returned — the account is not usable until email is confirmed.
router.post('/register', async (req, res) => {
  try {
    const { firstName, lastName, phone, experience, riderType, bikes, primaryTrack } = req.body;
    const email = normEmail(req.body.email);
    if (!firstName || !lastName || !email) return res.status(400).json({ error: 'firstName, lastName, and email are required' });

    const existing = getRiderByEmail(email);
    if (existing) {
      // Already fully registered → tell them to sign in.
      if (existing.verified && existing.passwordHash) {
        return res.status(409).json({ error: 'Email already registered. Please sign in.' });
      }
      // Pending → re-issue a fresh verification token/email (idempotent resend).
      const verifyToken = uuidv4();
      updateRider(existing.id, { verifyToken, verifyTokenExpiry: new Date(Date.now() + VERIFY_TTL_MS).toISOString() });
      await sendVerifyEmail(email, existing.firstName, verifyToken, email);
      return res.status(200).json({ success: true, pending: true, message: 'Verification email re-sent. Please check your inbox.' });
    }

    const verifyToken = uuidv4();
    createRider({
      id: uuidv4(), firstName, lastName, email, phone: phone || null,
      passwordHash: null, experience: experience || null, riderType: riderType || null,
      bikes: bikes || null, primaryTrack: primaryTrack || null, notes: null,
      verifyToken, verifyTokenExpiry: new Date(Date.now() + VERIFY_TTL_MS).toISOString()
    });
    await sendVerifyEmail(email, firstName, verifyToken, email);
    res.status(201).json({ success: true, pending: true, message: 'Check your email to confirm your account.' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Registration failed' }); }
});

// ── Verify email ─────────────────────────────────────────────────────────────
// Validates the token, marks the rider verified + records consent, and returns
// a short-lived setup token the client uses to POST /set-password.
router.post('/verify', (req, res) => {
  try {
    const token = req.body.token || req.query.token;
    if (!token) return res.status(400).json({ error: 'token is required' });
    const rider = getRiderByVerifyToken(token);
    if (!rider) return res.status(400).json({ error: 'Invalid or expired verification link' });
    if (rider.verifyTokenExpiry && new Date(rider.verifyTokenExpiry) < new Date()) {
      return res.status(400).json({ error: 'This verification link has expired. Please sign up again to get a new one.' });
    }

    const now = new Date().toISOString();
    updateRider(rider.id, { verified: 1, consentAt: rider.consentAt || now });
    // Whether or not they've set a password yet, tell the client the next step.
    const needsPassword = !rider.passwordHash;
    res.json({
      success: true,
      email: rider.email,
      firstName: rider.firstName,
      needsPassword,
      // setupToken lets the verified user set their first password without a session.
      setupToken: needsPassword ? jwt.sign({ riderId: rider.id, purpose: 'setup' }, JWT_SECRET, { expiresIn: '1h' }) : null
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Verification failed' }); }
});

// ── Set first password (post-verification) ───────────────────────────────────
router.post('/set-password', (req, res) => {
  try {
    const { setupToken, password } = req.body;
    if (!setupToken || !password) return res.status(400).json({ error: 'setupToken and password are required' });
    if (!isStrongPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters with uppercase, lowercase, and a number' });
    }
    let payload;
    try { payload = jwt.verify(setupToken, JWT_SECRET); } catch { return res.status(401).json({ error: 'Setup link expired. Please use the verify link in your email again.' }); }
    if (payload.purpose !== 'setup') return res.status(401).json({ error: 'Invalid setup token' });
    const rider = getRiderById(payload.riderId);
    if (!rider) return res.status(404).json({ error: 'Account not found' });
    if (!rider.verified) return res.status(403).json({ error: 'Email not verified' });

    const hash = bcrypt.hashSync(password, 10);
    // Clear the verify token now that the account is fully set up.
    const updated = updateRider(rider.id, { passwordHash: hash, verifyToken: null, verifyTokenExpiry: null });
    res.json({ success: true, token: signToken(rider.id), rider: sanitize(updated) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not set password' }); }
});

// ── Resend verification ──────────────────────────────────────────────────────
router.post('/resend-verification', async (req, res) => {
  try {
    const email = normEmail(req.body.email);
    if (!email) return res.status(400).json({ error: 'email is required' });
    const rider = getRiderByEmail(email);
    // Don't leak which emails exist; also skip already-active accounts.
    if (rider && !(rider.verified && rider.passwordHash)) {
      const verifyToken = uuidv4();
      updateRider(rider.id, { verifyToken, verifyTokenExpiry: new Date(Date.now() + VERIFY_TTL_MS).toISOString() });
      await sendVerifyEmail(rider.email, rider.firstName, verifyToken, rider.email);
    }
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Request failed' }); }
});

router.post('/login', (req, res) => {
  try {
    const email = normEmail(req.body.email);
    const { password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    const rider = getRiderByEmail(email);
    // Generic invalid-credentials for missing/no-password accounts to avoid enumeration.
    if (!rider || !rider.passwordHash || !bcrypt.compareSync(password, rider.passwordHash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (!rider.verified) {
      return res.status(403).json({ error: 'Please confirm your email before signing in.', needsVerification: true });
    }
    res.json({ success: true, token: signToken(rider.id), rider: sanitize(rider) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Login failed' }); }
});

router.post('/logout', requireAuth, (req, res) => res.json({ success: true }));

router.get('/me', requireAuth, (req, res) => {
  const rider = getRiderById(req.riderId);
  if (!rider) return res.status(404).json({ error: 'Not found' });
  res.json({ rider: sanitize(rider) });
});

router.put('/profile', requireAuth, (req, res) => {
  try {
    const { firstName, lastName, phone, experience, riderType, bikes, primaryTrack, notes } = req.body;
    const updated = updateRider(req.riderId, { firstName, lastName, phone, experience, riderType, bikes, primaryTrack, notes });
    res.json({ rider: sanitize(updated) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Update failed' }); }
});

// ── Membership plan selection (Phase 2: intent only, no payment yet) ────────────────
// Records the rider's chosen plan. Real entitlement/checkout is wired in Phase 3
// once a payment processor is selected. Accepts a coarse plan id + optional detail.
const ALLOWED_PLANS = ['free', 'per_event', 'season', 'pro'];
router.post('/select-plan', requireAuth, (req, res) => {
  try {
    const { plan } = req.body;
    if (!ALLOWED_PLANS.includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan. Choose one of: ' + ALLOWED_PLANS.join(', ') });
    }
    // NOTE: this only records selection/intent. It does NOT grant paid entitlements.
    const updated = updateRider(req.riderId, { plan });
    res.json({ success: true, plan, rider: sanitize(updated) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not save plan' }); }
});

// ── Forgot / Reset Password ─────────────────────────────────────────────────

function generateResetToken() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let token = '';
  for (let i = 0; i < 6; i++) token += chars[Math.floor(Math.random() * chars.length)];
  return token;
}

router.post('/forgot-password', (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });

    const rider = getRiderByEmail(email.trim().toLowerCase());
    if (!rider) {
      // Don't leak existence
      return res.json({ success: true });
    }

    const resetToken = generateResetToken();
    const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
    updateRider(rider.id, { resetToken, resetTokenExpiry: expiry });

    sendPasswordResetEmail(rider.email, rider.firstName, resetToken, rider.email);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Request failed' });
  }
});

router.post('/reset-password', (req, res) => {
  try {
    const { email, token, newPassword } = req.body;
    if (!email || !token || !newPassword) {
      return res.status(400).json({ error: 'email, token, and newPassword are required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const rider = getRiderByEmail(email.trim().toLowerCase());
    if (!rider) return res.status(400).json({ error: 'Invalid token or email' });

    if (rider.resetToken !== token) return res.status(400).json({ error: 'Invalid token' });
    if (!rider.resetTokenExpiry || new Date(rider.resetTokenExpiry) < new Date()) {
      return res.status(400).json({ error: 'Token has expired' });
    }

    const hash = bcrypt.hashSync(newPassword, 10);
    updateRider(rider.id, { passwordHash: hash, resetToken: null, resetTokenExpiry: null });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Reset failed' });
  }
});

router.post('/change-password', requireAuth, (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
    const rider = getRiderById(req.riderId);
    if (!rider) return res.status(404).json({ error: 'Not found' });
    if (!bcrypt.compareSync(currentPassword, rider.passwordHash)) return res.status(401).json({ error: 'Current password wrong' });
    updateRider(req.riderId, { passwordHash: bcrypt.hashSync(newPassword, 10) });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Change failed' }); }
});

export default router;
