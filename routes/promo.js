import express from 'express';
import { redeemPromoCode, getEntitlement } from '../lib/db.js';
import { requireAuth } from '../lib/middleware/auth.js';

const router = express.Router();

// POST /api/promo/redeem  { code }
// Auth-required. Validates + redeems a promo code for the logged-in rider,
// topping up their report credits. One redemption per code per rider.
router.post('/redeem', requireAuth, (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code || !String(code).trim()) {
      return res.status(400).json({ error: 'Promo code required' });
    }
    const result = redeemPromoCode(req.riderId, code);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }
    res.json({
      success: true,
      message: `Success! ${result.creditsGranted} token${result.creditsGranted === 1 ? '' : 's'} added.`,
      creditsGranted: result.creditsGranted,
      entitlement: result.entitlement
    });
  } catch (err) {
    console.error('[promo/redeem]', err);
    res.status(500).json({ error: 'Could not redeem code' });
  }
});

// GET /api/promo/entitlement — convenience: current rider's credit/plan state.
router.get('/entitlement', requireAuth, (req, res) => {
  try {
    const ent = getEntitlement(req.riderId);
    if (!ent) return res.status(404).json({ error: 'Rider not found' });
    res.json({ entitlement: ent });
  } catch (err) {
    console.error('[promo/entitlement]', err);
    res.status(500).json({ error: 'Failed' });
  }
});

export default router;
