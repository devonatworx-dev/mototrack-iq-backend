import express from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { getBetaSignups, getBetaSignupStats, deleteBetaSignup, getBetaSignupByEmail, setBetaConfirmToken, markBetaSignupConverted, getAllRiders, getRiderById, getRiderByEmail, createRider, updateRider, deleteRider, createPromoCode, listPromoCodes, getPromoCode, setPromoActive, addReportCredits, getAllFeedback, getFeedbackById, setFeedbackApproval, setFeedbackFeatured, deleteFeedback, deleteSession, updateSession, getRiderSessionsForAdmin, getRecentSessions, getSessionById } from '../lib/db.js';
import { signReportUrl } from '../lib/reportLink.js';
import { sendCredentialsEmail, sendBetaConfirmEmail } from '../lib/email.js';
import { requireAdmin } from '../lib/middleware/auth.js';

// Generate a readable but strong temporary password (no ambiguous chars).
function genTempPassword(len = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

const router = express.Router();

// All admin routes require a valid admin key (X-Admin-Key header / Bearer).
router.use(requireAdmin);

router.get('/signups', (req, res) => {
  try { res.json({ signups: getBetaSignups() }); }
  catch (err) { res.status(500).json({ error: 'Failed' }); }
});

router.get('/signups/stats', (req, res) => {
  try { res.json({ stats: getBetaSignupStats() }); }
  catch (err) { res.status(500).json({ error: 'Failed' }); }
});

router.delete('/signups/:email', (req, res) => {
  try { deleteBetaSignup(req.params.email); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// Admin: (re)send the double opt-in confirmation email for a PENDING signup.
// Unlike the public /api/beta/resend (which is enumeration-safe and silent),
// this returns real status so the admin knows if it actually sent. Mints a fresh
// confirm token + 7-day expiry each time. Refuses if already confirmed.
router.post('/signups/:email/resend-confirm', async (req, res) => {
  try {
    const email = String(req.params.email || '').trim().toLowerCase();
    const signup = getBetaSignupByEmail(email);
    if (!signup) return res.status(404).json({ error: 'Waitlist signup not found' });
    if (signup.confirmed) return res.status(409).json({ error: 'This signup is already confirmed.' });
    const confirmToken = uuidv4();
    const expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    setBetaConfirmToken(email, confirmToken, expiry);
    const mail = await sendBetaConfirmEmail(email, signup.firstName, confirmToken);
    if (!mail || mail.success === false) {
      return res.status(502).json({ error: (mail && mail.error) || 'Email send failed', emailSent: false });
    }
    res.json({ success: true, emailSent: true, email });
  } catch (err) {
    console.error('[admin/resend-confirm]', err);
    res.status(500).json({ error: err.message || 'Failed' });
  }
});

// Promote a CONFIRMED waitlist signup to a full member account, in one call:
//   1. auto-generate a temp password
//   2. create a pre-verified rider (skips email verification)
//   3. grant intro report credits (default 1 = "first report FREE")
//   4. email the rider their credentials + sign-in link
//   5. mark the signup as converted so it drops off the pending list
// Body (all optional): { credits?, plan?, password? }
//   - credits: number of report credits (default 1). Note: new riders already
//     get 1 credit by DB default, so we only ADD extra beyond that.
//   - password: override the auto-generated temp password.
router.post('/signups/:email/promote', async (req, res) => {
  try {
    const email = String(req.params.email || '').trim().toLowerCase();
    const signup = getBetaSignupByEmail(email);
    if (!signup) return res.status(404).json({ error: 'Waitlist signup not found' });
    if (!signup.confirmed) {
      return res.status(409).json({ error: 'This signup has not confirmed their email yet. Only confirmed signups can be promoted.' });
    }
    if (getRiderByEmail(email)) {
      return res.status(409).json({ error: 'A rider account with that email already exists.' });
    }

    const tempPassword = req.body?.password && String(req.body.password).length >= 6
      ? String(req.body.password)
      : genTempPassword();
    // Default to 1 credit total. New riders already receive 1 by DB default,
    // so only add the extra beyond the built-in first credit.
    const requestedCredits = req.body?.credits === undefined ? 1 : parseInt(req.body.credits, 10);
    const credits = Number.isFinite(requestedCredits) && requestedCredits >= 0 ? requestedCredits : 1;
    const plan = req.body?.plan || null;

    const id = uuidv4();
    const now = new Date().toISOString();
    const passwordHash = bcrypt.hashSync(tempPassword, 10);
    createRider({
      id,
      firstName: signup.firstName,
      lastName: signup.lastName || '',
      email,
      passwordHash,
      bikes: signup.bike || null,
      primaryTrack: signup.track || null,
      experience: signup.experience || null,
      consentAt: signup.confirmedAt || now
    });
    // Pre-verify + set plan intent (createRider inserts verified=0).
    updateRider(id, { verified: 1, verifyToken: null, verifyTokenExpiry: null, plan });

    // New riders default to 1 credit; top up to the requested total.
    let entitlement = null;
    const extra = credits - 1;
    if (extra > 0) entitlement = addReportCredits(id, extra);

    // Mark the signup converted so it leaves the pending list.
    markBetaSignupConverted(email, id);

    // Email the rider their credentials. Awaited so we can report send status,
    // but a delivery failure does NOT roll back the account (admin can resend).
    const mail = await sendCredentialsEmail(email, signup.firstName, tempPassword, { credits });

    const rider = getRiderById(id);
    const { passwordHash: _ph, verifyToken: _vt, resetToken: _rt, resetTokenExpiry: _re, ...safe } = rider;
    res.status(201).json({
      success: true,
      rider: safe,
      credits,
      entitlement,
      emailSent: !!(mail && mail.success),
      emailError: mail && mail.success === false ? mail.error : undefined
    });
  } catch (err) {
    console.error('[admin/signups promote]', err);
    res.status(500).json({ error: err.message || 'Failed' });
  }
});

// ── Feedback moderation ──────────────────────────────────────────────
router.get('/feedback', (req, res) => {
  try { res.json({ feedback: getAllFeedback() }); }
  catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// Approve / unapprove for public display. Body: { approved: true|false }
router.post('/feedback/:id/approve', (req, res) => {
  try {
    const fb = getFeedbackById(req.params.id);
    if (!fb) return res.status(404).json({ error: 'Not found' });
    const updated = setFeedbackApproval(req.params.id, !!req.body.approved);
    res.json({ success: true, feedback: updated });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// Feature / unfeature (pin to top of testimonials). Body: { featured: true|false }
router.post('/feedback/:id/feature', (req, res) => {
  try {
    const fb = getFeedbackById(req.params.id);
    if (!fb) return res.status(404).json({ error: 'Not found' });
    const updated = setFeedbackFeatured(req.params.id, !!req.body.featured);
    res.json({ success: true, feedback: updated });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

router.delete('/feedback/:id', (req, res) => {
  try {
    const fb = getFeedbackById(req.params.id);
    if (!fb) return res.status(404).json({ error: 'Not found' });
    deleteFeedback(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

router.get('/riders', (req, res) => {
  try {
    const riders = getAllRiders();
    const safe = riders.map(({ passwordHash, verifyToken, resetToken, resetTokenExpiry, ...r }) => r);
    res.json({ riders: safe });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// Admin: create a PRE-VERIFIED rider with a password (and optional report credits)
// in one call. Bypasses the email verification flow — for trackside/beta onboarding
// when a rider can't do the email dance. Body:
//   { firstName, lastName?, email, password, credits?, plan?, bikes?, primaryTrack? }
router.post('/riders', (req, res) => {
  try {
    const { firstName, lastName, email, password, credits, plan, bikes, primaryTrack, riderType, experience } = req.body || {};
    if (!firstName || !email || !password) {
      return res.status(400).json({ error: 'firstName, email, and password are required' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    if (getRiderByEmail(email)) {
      return res.status(409).json({ error: 'A rider with that email already exists' });
    }
    const id = uuidv4();
    const now = new Date().toISOString();
    const passwordHash = bcrypt.hashSync(String(password), 10);
    createRider({
      id, firstName, lastName: lastName || '', email,
      passwordHash, bikes: bikes || null, primaryTrack: primaryTrack || null,
      riderType: riderType || null, experience: experience || null,
      consentAt: now
    });
    // Mark verified immediately (createRider inserts verified=0) and set plan intent.
    updateRider(id, { verified: 1, verifyToken: null, verifyTokenExpiry: null, plan: plan || null });
    const n = parseInt(credits, 10);
    let entitlement = null;
    if (n && n > 0) entitlement = addReportCredits(id, n);
    const rider = getRiderById(id);
    const { passwordHash: _ph, verifyToken: _vt, resetToken: _rt, resetTokenExpiry: _re, ...safe } = rider;
    res.status(201).json({ success: true, rider: safe, entitlement });
  } catch (err) {
    console.error('[admin/riders create]', err);
    res.status(500).json({ error: err.message || 'Failed' });
  }
});

router.delete('/riders/:id', (req, res) => {
  try {
    const rider = getRiderById(req.params.id);
    if (!rider) return res.status(404).json({ error: 'Rider not found' });
    deleteRider(rider.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

router.patch('/riders/:id', (req, res) => {
  try {
    const rider = getRiderById(req.params.id);
    if (!rider) return res.status(404).json({ error: 'Rider not found' });
    const allowed = ['firstName','lastName','phone','experience','riderType','bikes','primaryTrack','notes'];
    const updates = {};
    for (const key of allowed) {
      if (key in req.body) updates[key] = req.body[key];
    }
    const updated = updateRider(rider.id, updates);
    res.json({ success: true, rider: updated });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// Admin: all sessions/reports for a specific rider (troubleshooting drill-down).
router.get('/riders/:id/sessions', (req, res) => {
  try {
    const rider = getRiderById(req.params.id);
    if (!rider) return res.status(404).json({ error: 'Rider not found' });
    res.json({ sessions: getRiderSessionsForAdmin(rider.id) });
  } catch (err) { console.error('[admin/riders sessions]', err); res.status(500).json({ error: 'Failed' }); }
});

// Admin: mint a short-lived signed link to download any session's report PDF
// (for troubleshooting). Requires admin key (router-level requireAdmin).
router.get('/sessions/:id/report-link', (req, res) => {
  try {
    const session = getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({ url: signReportUrl(session.id) });
  } catch (err) { console.error('[admin report-link]', err); res.status(500).json({ error: 'Failed' }); }
});

// Admin: recent sessions across ALL riders (spot failures at a glance).
router.get('/sessions/recent', (req, res) => {
  try {
    res.json({ sessions: getRecentSessions(req.query.limit) });
  } catch (err) { console.error('[admin/sessions recent]', err); res.status(500).json({ error: 'Failed' }); }
});

router.delete('/sessions/:id', (req, res) => {
  try {
    deleteSession(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

router.patch('/sessions/:id', (req, res) => {
  try {
    const updated = updateSession(req.params.id, req.body);
    res.json({ success: true, session: updated });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

router.post('/riders/:id/reset-password', (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const rider = getRiderById(req.params.id);
    if (!rider) return res.status(404).json({ error: 'Rider not found' });
    const hash = bcrypt.hashSync(newPassword, 10);
    updateRider(rider.id, { passwordHash: hash });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// ── Promo code management (P1b) ─────────────────────────────────────
router.get('/promo', (req, res) => {
  try { res.json({ codes: listPromoCodes() }); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Failed' }); }
});

router.post('/promo', (req, res) => {
  try {
    const { code, creditsGranted, maxUses, expiresAt, note } = req.body;
    if (!code || !String(code).trim()) return res.status(400).json({ error: 'code required' });
    if (getPromoCode(code)) return res.status(409).json({ error: 'Code already exists' });
    const created = createPromoCode({ code, creditsGranted, maxUses, expiresAt, note });
    res.status(201).json({ code: created });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message || 'Failed' }); }
});

router.post('/promo/:code/disable', (req, res) => {
  try {
    if (!getPromoCode(req.params.code)) return res.status(404).json({ error: 'Not found' });
    res.json({ code: setPromoActive(req.params.code, false) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed' }); }
});

router.post('/promo/:code/enable', (req, res) => {
  try {
    if (!getPromoCode(req.params.code)) return res.status(404).json({ error: 'Not found' });
    res.json({ code: setPromoActive(req.params.code, true) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed' }); }
});

// Manually grant report credits to a rider (support / goodwill).
router.post('/riders/:id/grant-credits', (req, res) => {
  try {
    const amount = parseInt(req.body.amount, 10);
    if (!amount || amount < 1) return res.status(400).json({ error: 'amount (>=1) required' });
    const rider = getRiderById(req.params.id);
    if (!rider) return res.status(404).json({ error: 'Rider not found' });
    const entitlement = addReportCredits(rider.id, amount);
    res.json({ success: true, entitlement });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed' }); }
});

// Absolute SET of a rider's token balance (admin/QA). Unlike grant-credits (which
// adds), this sets reportCredits to an exact value — handy for resetting a test
// account to a known state. Body: { tokens: <int >=0>, resetGenerated?: bool }
router.post('/riders/:id/set-tokens', (req, res) => {
  try {
    const tokens = parseInt(req.body.tokens, 10);
    if (!Number.isFinite(tokens) || tokens < 0) return res.status(400).json({ error: 'tokens (>=0) required' });
    const rider = getRiderById(req.params.id);
    if (!rider) return res.status(404).json({ error: 'Rider not found' });
    const updates = { reportCredits: tokens };
    if (req.body.resetGenerated) updates.reportsGenerated = 0;
    updateRider(rider.id, updates);
    const after = getRiderById(rider.id);
    res.json({ success: true, reportCredits: after.reportCredits, reportsGenerated: after.reportsGenerated });
  } catch (err) { console.error('[admin/set-tokens]', err); res.status(500).json({ error: err.message || 'Failed' }); }
});

export default router;
