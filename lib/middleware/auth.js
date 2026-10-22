'use strict';

import jwt from 'jsonwebtoken';
import config from '../config.js';

// No hardcoded fallback: JWT_SECRET is required and the process refuses to
// start without it. The previous fallback ('<REDACTED-JWT-LITERAL>')
// was committed to a public repo, so it was a well-known constant that
// let anyone forge valid rider tokens.
const JWT_SECRET = config.jwtSecret;

export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.riderId = decoded.riderId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Admin gate: requires a shared secret in the X-Admin-Key header (or Bearer) that
// matches the ADMIN_KEY env var. Fails closed if ADMIN_KEY is unset.
export function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_KEY;
  if (!expected) {
    return res.status(503).json({ error: 'Admin access not configured' });
  }
  const provided =
    req.headers['x-admin-key'] ||
    (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null);
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  next();
}

export function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.riderId = decoded.riderId;
    } catch (err) {
      // ignore invalid token for optional auth
    }
  }
  next();
}
