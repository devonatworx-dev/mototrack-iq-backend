import express from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { getBetaSignups, getBetaSignupStats, deleteBetaSignup, getAllRiders, getRiderById, getRiderByEmail, createRider, updateRider, deleteRider, createPromoCode, listPromoCodes, getPromoCode, setPromoActive, addReportCredits, getAllFeedback, getFeedbackById, setFeedbackApproval, setFeedbackFeatured, deleteFeedback, deleteSession, updateSession, getRiderSessionsForAdmin, getRecentSessions, getSessionById } from '../lib/db.js';
import { signReportUrl } from '../lib/reportLink.js';
import { requireAdmin } from '../lib/middleware/auth.js';

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

export default router;
