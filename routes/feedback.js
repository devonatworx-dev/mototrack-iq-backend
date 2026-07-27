import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { optionalAuth } from '../lib/middleware/auth.js';
import {
  createFeedback,
  getRiderById,
  getPublicTestimonials,
} from '../lib/db.js';

const router = express.Router();

// ── Submit feedback (public; auth optional) ──────────────────────────────────
// Called by the in-app review modal after a rider generates a report. Works for
// logged-in riders (we attach their name/email) and anonymous submitters alike.
// `consentPublic` = the rider ticked "you may feature this publicly". Nothing is
// ever shown publicly until an admin also approves it.
router.post('/', optionalAuth, (req, res) => {
  try {
    let { rating, comment, consentPublic, riderName, email } = req.body;

    rating = rating != null ? parseInt(rating, 10) : null;
    if (rating != null && (isNaN(rating) || rating < 1 || rating > 5)) {
      return res.status(400).json({ error: 'rating must be 1–5' });
    }
    comment = (comment || '').toString().trim().slice(0, 2000);
    if (!rating && !comment) {
      return res.status(400).json({ error: 'Provide a rating or a comment' });
    }

    // Prefer authenticated identity when available.
    let riderId = req.riderId || null;
    if (riderId) {
      const rider = getRiderById(riderId);
      if (rider) {
        riderName = riderName || `${rider.firstName} ${rider.lastName}`.trim();
        email = email || rider.email;
      }
    }
    riderName = (riderName || '').toString().trim().slice(0, 120) || null;
    email = (email || '').toString().trim().toLowerCase().slice(0, 254) || null;

    const fb = createFeedback({
      id: uuidv4(),
      riderId,
      riderName,
      email,
      rating,
      comment: comment || null,
      consentPublic: consentPublic ? 1 : 0,
      source: 'in-app',
    });

    return res.status(201).json({ success: true, id: fb.id });
  } catch (err) {
    console.error('[feedback:submit]', err);
    return res.status(500).json({ error: 'Failed to save feedback' });
  }
});

// ── Public testimonials (approved + consented only) ───────────────────────────
// Safe to expose on the marketing site. Never returns email or raw riderId.
router.get('/testimonials', (req, res) => {
  try {
    const items = getPublicTestimonials().map((t) => ({
      id: t.id,
      name: t.riderName || 'MotoTrackIQ Rider',
      rating: t.rating,
      comment: t.comment,
      featured: !!t.featured,
      date: t.createdAt,
    }));
    return res.json({ testimonials: items });
  } catch (err) {
    console.error('[feedback:testimonials]', err);
    return res.status(500).json({ error: 'Failed' });
  }
});

export default router;
