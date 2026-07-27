import express from 'express';
import bcrypt from 'bcryptjs';
import { getBetaSignups, getBetaSignupStats, deleteBetaSignup, getAllRiders, getRiderById, updateRider, deleteRider, createPromoCode, listPromoCodes, getPromoCode, setPromoActive, addReportCredits, getAllFeedback, getFeedbackById, setFeedbackApproval, setFeedbackFeatured, deleteFeedback } from '../lib/db.js';
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

router.delete('/riders/:id', (req, res) => {
  try {
    const rider = getRiderById(req.params.id);
    if (!rider) return res.status(404).json({ error: 'Rider not found' });
    deleteRider(rider.id);
    res.json({ success: true });
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
