import { sendRiderFollowupEmail } from '../lib/email.js';

// Validation send for Everett (eacooke10@gmail.com) to inspect rendering +
// headers. Uses the product code path so the subject goes through
// encodeHeader() and the body through the shared htmlWrap() template.
const result = await sendRiderFollowupEmail('eacooke10@gmail.com', 'Everett', {
  credits: 1,
  sessions: [
    { track: 'Calabogie Motorsports Park', date: '2026-07-08', laps: 5, bestLap: '167.52' },
    { track: 'Shannonville', date: '2026-05-22', laps: 8, bestLap: '91.92' }
  ],
  // eacooke10 self-registered (confirm→set-password flow), so he chose his own
  // password — the temp-password instruction would be wrong for him.
  hasTempPassword: false,
  subject: 'Your MotoTrackIQ account is ready — sign in and get your first report'
});

console.log('RESULT:', JSON.stringify(result));
