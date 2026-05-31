import { v4 as uuidv4 } from 'uuid';
import { createBetaSignup, getBetaSignups } from '../lib/db.js';
import { sendBetaSignupNotification } from '../lib/email.js';

export async function signupHandler(req, res) {
  try {
    const { firstName, lastName, email, bike, track, experience, source, consent } = req.body;
    if (!firstName || !lastName || !email) return res.status(400).json({ error: 'firstName, lastName, email required' });
    if (!consent) return res.status(400).json({ error: 'Consent required' });
    if (getBetaSignups().find(s => s.email === email)) return res.status(409).json({ error: 'Already on waitlist' });
    const ip = req.ip || req.connection?.remoteAddress || null;
    const signup = createBetaSignup({ id: uuidv4(), firstName, lastName, email, bike: bike||null, track: track||null, experience: experience||null, source: source||'direct', consent: 1, submittedAt: new Date().toISOString(), ip });
    sendBetaSignupNotification({ firstName, lastName, email, bike, track, experience, source }).catch(()=>{});
    res.status(201).json({ success: true, signup });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Signup failed' }); }
}

export async function countHandler(req, res) {
  try { res.json({ count: getBetaSignups().length }); }
  catch (err) { res.status(500).json({ error: 'Failed' }); }
}
