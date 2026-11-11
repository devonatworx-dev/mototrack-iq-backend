'use strict';
// Clerk-based auth middleware for the dev branch.
// Replaces lib/middleware/auth.js (custom JWT) with Clerk session validation.
// API consumers must send: Authorization: Bearer <clerk-session-token>

import { clerkMiddleware, requireAuth as clerkRequireAuth, getAuth } from '@clerk/express';
import { getRiderByClerkId } from '../db.js';

// Apply globally to server.js to enable session handling on all routes
export { clerkMiddleware };

// Drop-in replacement for the custom requireAuth middleware.
// After validation, sets req.clerkUserId and req.riderId (if rider exists).
export async function requireAuth(req, res, next) {
  const handler = clerkRequireAuth();
  handler(req, res, async () => {
    try {
      const { userId } = getAuth(req);
      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      req.clerkUserId = userId;
      // Look up rider record for this Clerk user (may be null for new users)
      const rider = await getRiderByClerkId(userId);
      req.riderId = rider ? rider.id : null;
      if (rider) req.rider = rider;
      next();
    } catch (err) {
      console.error('requireAuth error:', err.message);
      res.status(401).json({ error: 'Authentication failed' });
    }
  });
}
