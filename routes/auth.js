import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { createRider, getRiderByEmail, getRiderById, getRiderByVerifyToken, updateRider } from '../lib/db.js';
import { sendVerifyEmail, sendPasswordResetEmail, sendWelcomeEmail } from '../lib/email.js';
import { requireAuth } from '../lib/middleware/auth.js';
import config from '../lib/config.js';
import oauthRoutes from './oauth.js';
import { requireTurnstile } from '../lib/turnstile.js';
import { authRateLimit } from '../lib/rate-limit.js';

const router = express.Router();
// Required secret, no fallback (see lib/config.js for why).
const JWT_SECRET = config.jwtSecret;

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
// Signup does not consult beta_signups. The waitlist stays in place for
// people already on it; it is not a gate for a new account.
router.post('/register', authRateLimit('register'), requireTurnstile, async (req, res) => {
  try {
    const { firstName, lastName, phone, experience, riderType, bikes, primaryTrack, lapTimer, ontarioResident } = req.body;
    const email = normEmail(req.body.email);
    if (!firstName || !lastName || !email) return res.status(400).json({ error: 'firstName, lastName, and email are required' });
    // Territory safeguard: MotoTrackIQ (Ontario sole proprietorship) currently
    // serves Ontario residents only. Require an explicit attestation at signup.
    if (!ontarioResident) return res.status(400).json({ error: 'MotoTrackIQ is currently available only to residents of Ontario, Canada. Please confirm Ontario residency to continue.' });
    const ontarioAttestedAt = new Date().toISOString();

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
      bikes: bikes || null, primaryTrack: primaryTrack || null, lapTimer: lapTimer || null, notes: null,
      verifyToken, verifyTokenExpiry: new Date(Date.now() + VERIFY_TTL_MS).toISOString(),
      ontarioAttestedAt
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
    // Fire-and-forget welcome email confirming the account is active (non-blocking).
    sendWelcomeEmail(updated.email, updated.firstName, {
      lastName: updated.lastName, primaryTrack: updated.primaryTrack,
      experience: updated.experience, plan: updated.plan
    })
      .then(r => { if (!r || r.success === false) console.error('Welcome email failed:', r && r.error); })
      .catch(e => console.error('Welcome email threw:', e && e.message));
    res.json({ success: true, token: signToken(rider.id), rider: sanitize(updated) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not set password' }); }
});

// ── Resend verification ──────────────────────────────────────────────────────
router.post('/resend-verification', authRateLimit('resend-verification'), requireTurnstile, async (req, res) => {
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

router.post('/login', authRateLimit('login'), requireTurnstile, (req, res) => {
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

// Fields a rider may change about themselves. Only keys actually present in the
// request body are written, so a partial update (for example just a name
// change) never blanks the other columns.
const PROFILE_FIELDS = ['firstName', 'lastName', 'phone', 'experience', 'riderType', 'bikes', 'primaryTrack', 'lapTimer', 'notes'];
const PROFILE_MAX_LEN = { firstName: 60, lastName: 60, phone: 40, experience: 40, riderType: 40, bikes: 500, primaryTrack: 120, lapTimer: 120, notes: 2000 };

export function pickProfileUpdates(body) {
  const updates = {};
  const src = body && typeof body === 'object' ? body : {};
  for (const key of PROFILE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(src, key) || src[key] === undefined) continue;
    const raw = src[key];
    if (raw === null) {
      if (key === 'firstName' || key === 'lastName') return { error: `${key} cannot be empty` };
      updates[key] = null;
      continue;
    }
    if (typeof raw !== 'string' && typeof raw !== 'number') return { error: `${key} must be text` };
    const val = String(raw).trim();
    if (val.length > PROFILE_MAX_LEN[key]) return { error: `${key} is too long` };
    if (key === 'firstName' && !val) return { error: 'First name cannot be empty' };
    // lastName may be blank (the riders column is NOT NULL, so store '').
    updates[key] = key === 'lastName' ? val : (val || null);
  }
  return { updates };
}

router.put('/profile', requireAuth, (req, res) => {
  try {
    const { updates, error } = pickProfileUpdates(req.body);
    if (error) return res.status(400).json({ error });
    const rider = getRiderById(req.riderId);
    if (!rider) return res.status(404).json({ error: 'Account not found' });
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });
    const updated = updateRider(req.riderId, updates);
    res.json({ success: true, rider: sanitize(updated) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Update failed' }); }
});

// ── Membership plan selection ───────────────────────────────────────────────
// The riders.plan column is what getEntitlement() reads, and 'season' / 'pro'
// there mean unlimited reports. So this route must never write a paid plan:
// paid access only comes from a verified Lemon Squeezy webhook. 'free' and
// 'per_event' grant nothing by themselves (per-event access is report credits),
// so recording them as interest stays allowed.
const ALLOWED_PLANS = ['free', 'per_event', 'season', 'pro'];
const UNLIMITED_PLAN_IDS = ['season', 'pro'];
router.post('/select-plan', requireAuth, (req, res) => {
  try {
    const { plan } = req.body || {};
    if (!ALLOWED_PLANS.includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan. Choose one of: ' + ALLOWED_PLANS.join(', ') });
    }
    if (UNLIMITED_PLAN_IDS.includes(plan)) {
      return res.status(402).json({ error: 'Paid plans are bought through checkout.', code: 'checkout_required' });
    }
    const rider = getRiderById(req.riderId);
    if (!rider) return res.status(404).json({ error: 'Account not found' });
    // Never downgrade a paid plan from here.
    if (rider.plan && !['free', 'per_event'].includes(rider.plan)) {
      return res.json({ success: true, plan: rider.plan, rider: sanitize(rider) });
    }
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

router.post('/forgot-password', authRateLimit('forgot-password'), requireTurnstile, (req, res) => {
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
    if (!rider.passwordHash) {
      return res.status(400).json({ error: 'This account signs in with Google or Microsoft. Use Forgot password if you also want a password.' });
    }
    if (!bcrypt.compareSync(currentPassword, rider.passwordHash)) return res.status(401).json({ error: 'Current password wrong' });
    updateRider(req.riderId, { passwordHash: bcrypt.hashSync(newPassword, 10) });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Change failed' }); }
});

router.use('/oauth', oauthRoutes);

export default router;
