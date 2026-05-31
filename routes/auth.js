import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { createRider, getRiderByEmail, getRiderById, updateRider } from '../lib/db.js';
import { sendWelcomeEmail, sendPasswordResetEmail } from '../lib/email.js';
import { requireAuth } from '../lib/middleware/auth.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || '<REDACTED-JWT-LITERAL>';

function signToken(riderId) { return jwt.sign({ riderId }, JWT_SECRET, { expiresIn: '30d' }); }
function sanitize(rider) { const { passwordHash, verifyToken, ...s } = rider; return s; }

function isStrongPassword(pwd) {
  if (!pwd || pwd.length < 8) return false;
  if (!/[A-Z]/.test(pwd)) return false;
  if (!/[a-z]/.test(pwd)) return false;
  if (!/[0-9]/.test(pwd)) return false;
  return true;
}

router.post('/register', async (req, res) => {
  try {
    const { firstName, lastName, email, phone, password, experience, riderType, bikes, primaryTrack } = req.body;
    if (!firstName || !lastName || !email) return res.status(400).json({ error: 'firstName, lastName, and email are required' });
    if (getRiderByEmail(email)) return res.status(409).json({ error: 'Email already registered' });
    if (!isStrongPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters with uppercase, lowercase, and a number' });
    }
    const pwd = password;
    const hash = bcrypt.hashSync(pwd, 10);
    const rider = createRider({ id: uuidv4(), firstName, lastName, email, phone: phone||null, passwordHash: hash, experience: experience||null, riderType: riderType||null, bikes: bikes||null, primaryTrack: primaryTrack||null, notes: null, verifyToken: uuidv4() });
    await sendWelcomeEmail(email, firstName, pwd);
    res.status(201).json({ success: true, token: signToken(rider.id), rider: sanitize(rider) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Registration failed' }); }
});

router.post('/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    const rider = getRiderByEmail(email);
    if (!rider || !bcrypt.compareSync(password, rider.passwordHash)) return res.status(401).json({ error: 'Invalid credentials' });
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
