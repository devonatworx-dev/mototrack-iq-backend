import express from 'express';
import bcrypt from 'bcryptjs';
import { getBetaSignups, getBetaSignupStats, deleteBetaSignup, getAllRiders, getRiderById, updateRider } from '../lib/db.js';
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

router.get('/riders', (req, res) => {
  try {
    const riders = getAllRiders();
    const safe = riders.map(({ passwordHash, verifyToken, resetToken, resetTokenExpiry, ...r }) => r);
    res.json({ riders: safe });
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

export default router;
