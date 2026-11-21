import { randomUUID } from 'node:crypto';
import {
  attachOAuthIdentity,
  createRider,
  getOAuthIdentity,
  getRiderByEmail,
  getRiderById,
  updateRider,
} from './db.js';

function normEmail(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Turn a verified provider profile into a rider.
 * Existing password accounts stay password accounts: linking only adds a row
 * in oauth_identities and never replaces passwordHash.
 * A new rider still has to opt into product email and attest Ontario residency,
 * the same two gates as /api/auth/register.
 */
export function settleOAuthAccount(profile, { consent = false, ontario = false } = {}) {
  if (!profile?.providerUserId) {
    return { error: 'oauth_failed' };
  }
  const email = normEmail(profile.email);
  const identity = getOAuthIdentity(profile.provider, profile.providerUserId);
  if (identity) {
    const rider = getRiderById(identity.rider_id);
    if (!rider) return { error: 'oauth_failed' };
    return { rider, isNew: false, linked: false };
  }

  if (!email) return { error: 'missing_email' };

  const existing = getRiderByEmail(email);
  if (existing) {
    if (!profile.emailVerified) return { error: 'email_unverified' };
    attachOAuthIdentity({
      provider: profile.provider,
      providerUserId: profile.providerUserId,
      riderId: existing.id,
      email,
      emailVerified: true,
    });
    let rider = existing;
    if (!rider.verified) rider = updateRider(rider.id, { verified: 1 });
    return { rider, isNew: false, linked: true };
  }

  if (!profile.emailVerified) return { error: 'email_unverified' };
  if (!consent) return { error: 'consent_required' };
  if (!ontario) return { error: 'ontario_required' };

  const now = new Date().toISOString();
  let rider = createRider({
    id: randomUUID(),
    firstName: profile.firstName || 'Rider',
    lastName: profile.lastName || '',
    email,
    passwordHash: null,
    consentAt: now,
    ontarioAttestedAt: now,
  });
  rider = updateRider(rider.id, { verified: 1, reportCredits: 1 });
  attachOAuthIdentity({
    provider: profile.provider,
    providerUserId: profile.providerUserId,
    riderId: rider.id,
    email,
    emailVerified: true,
  });
  return { rider, isNew: true, linked: false };
}
