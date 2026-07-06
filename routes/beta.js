import { v4 as uuidv4 } from 'uuid';
import {
  createBetaSignup, getBetaSignups, getBetaSignupByEmail,
  getBetaSignupByConfirmToken, setBetaConfirmToken, confirmBetaSignup
} from '../lib/db.js';
import { sendBetaSignupNotification, sendBetaConfirmEmail } from '../lib/email.js';

function normEmail(e) { return String(e || '').trim().toLowerCase(); }

// Confirmation links are valid for 7 days.
const CONFIRM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
function newConfirmExpiry() { return new Date(Date.now() + CONFIRM_TTL_MS).toISOString(); }

// Waitlist signup — DOUBLE OPT-IN.
// Records the signup as UNCONFIRMED and emails the signer a confirmation link.
// The admin notification is deferred until they confirm (so fake emails never
// generate a lead). Re-submitting an unconfirmed email re-sends the confirm link.
export async function signupHandler(req, res) {
  try {
    const { firstName, lastName, bike, track, experience, source, consent } = req.body;
    const email = normEmail(req.body.email);
    if (!firstName || !lastName || !email) return res.status(400).json({ error: 'firstName, lastName, email required' });
    if (!consent) return res.status(400).json({ error: 'Consent required' });

    const existing = getBetaSignupByEmail(email);
    if (existing) {
      if (existing.confirmed) {
        return res.status(409).json({ error: 'You are already on the waitlist.' });
      }
      // Unconfirmed → re-issue a fresh confirm token and resend.
      const confirmToken = uuidv4();
      setBetaConfirmToken(email, confirmToken, newConfirmExpiry());
      await sendBetaConfirmEmail(email, existing.firstName, confirmToken);
      return res.status(200).json({ success: true, pending: true, message: 'Confirmation email re-sent. Please check your inbox.' });
    }

    const ip = req.ip || req.connection?.remoteAddress || null;
    const confirmToken = uuidv4();
    createBetaSignup({
      id: uuidv4(), firstName, lastName, email,
      bike: bike || null, track: track || null, experience: experience || null,
      source: source || 'direct', consent: 1, confirmToken,
      confirmTokenExpiry: newConfirmExpiry(),
      submittedAt: new Date().toISOString(), ip
    });
    await sendBetaConfirmEmail(email, firstName, confirmToken);
    res.status(201).json({ success: true, pending: true, message: 'Almost there! Check your email to confirm your spot.' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Signup failed' }); }
}

// Confirm a waitlist signup via the emailed token (double opt-in completion).
export async function confirmHandler(req, res) {
  try {
    const token = req.body.token || req.query.token;
    if (!token) return res.status(400).json({ error: 'token is required' });
    const signup = getBetaSignupByConfirmToken(token);
    if (!signup) return res.status(400).json({ error: 'This confirmation link is invalid or has already been used.', code: 'invalid' });

    // Already confirmed via this token? Treat as success (idempotent).
    if (signup.confirmed) {
      return res.json({ success: true, firstName: signup.firstName, alreadyConfirmed: true });
    }

    // Expired link → tell the client so it can offer a resend.
    if (signup.confirmTokenExpiry && Date.now() > new Date(signup.confirmTokenExpiry).getTime()) {
      return res.status(410).json({ error: 'This confirmation link has expired. Request a new one below.', code: 'expired' });
    }

    const confirmed = confirmBetaSignup(signup.id);
    // Now that the email is verified + consent explicit, notify the admin.
    sendBetaSignupNotification({
      firstName: confirmed.firstName, lastName: confirmed.lastName, email: confirmed.email,
      bike: confirmed.bike, track: confirmed.track, experience: confirmed.experience, source: confirmed.source
    })
      .then(r => { if (!r || r.success === false) console.error('Beta notify failed:', r && r.error); })
      .catch(e => console.error('Beta notify threw:', e && e.message));

    res.json({ success: true, firstName: confirmed.firstName });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Confirmation failed' }); }
}

// Resend a fresh confirmation link to an UNCONFIRMED waitlist email.
// Enumeration-safe: always returns a generic success message.
export async function resendHandler(req, res) {
  try {
    const email = normEmail(req.body.email);
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const existing = getBetaSignupByEmail(email);
    // Only resend for a real, still-unconfirmed signup — but respond the same either way.
    if (existing && !existing.confirmed) {
      const confirmToken = uuidv4();
      setBetaConfirmToken(email, confirmToken, newConfirmExpiry());
      await sendBetaConfirmEmail(email, existing.firstName, confirmToken);
    }
    return res.json({ success: true, message: 'If that email is on the waitlist and not yet confirmed, a fresh confirmation link is on its way.' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Resend failed' }); }
}

// Public count = CONFIRMED signups only (the real, opted-in list).
export async function countHandler(req, res) {
  try { res.json({ count: getBetaSignups().filter(s => s.confirmed).length }); }
  catch (err) { res.status(500).json({ error: 'Failed' }); }
}
