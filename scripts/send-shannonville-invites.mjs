// Sends the beta-invite touch-base to the two Shannonville track-day leads
// (Maurice Guimont, Rex Gabriel) who were never on the waitlist and have NO
// rider account.
//
// WHY THIS EXISTS AS A SCRIPT AND NOT AN AD-HOC MIME PAYLOAD:
// A rider mail must go through lib/email.js so the Subject goes through
// encodeHeader() (RFC 2047). Bypassing it is what caused four mails with a
// garbled "Ã¢Â€Â"" subject on 2026-10-23.
//
// FACTS VERIFIED 2026-11-01 against prod (GET /api/admin/signups, /riders):
//   - Neither email is on the production waitlist (6 rows, neither present).
//   - Neither has a rider account (roster of 12, neither present).
//   - Each received exactly ONE mail from us: 2026-10-04, the "Your
//     MotoTrackIQ report - good/great meeting you at Shannonville" pair.
//     No reply. No further contact. So this is a first touch since Oct 4.
//   - Neither has ever had an account, therefore there is NO temp password,
//     no credit count, and no session count to state. The copy claims
//     none of those.
//
// The copy must NOT say their access is ready. It must NOT contain a
// password. The rider consents by submitting the waitlist form themselves.
//
// Usage:
//   node scripts/send-shannonville-invites.mjs            # preflight + send
//   DRY_RUN=1 node scripts/send-shannonville-invites.mjs  # preflight only
//   VALIDATE_ONLY=1 node scripts/send-shannonville-invites.mjs  # only the copy to Everett

import { sendBetaInviteEmail, buildBetaInviteHtml } from '../lib/email.js';

const SITE = 'https://mototrackiq.com';

// ── Maurice Guimont ─────────────────────────────────────────────────────────
// BMW S1000RR (2020). Runs an AiM Solo 2.
const MAURICE = {
  to: 'mlguimont1098@gmail.com',
  firstName: 'Maurice',
  kind: 'aim',
  subject: 'Maurice — MotoTrackIQ follow-up (and my apologies for going quiet)',
  signOff: 'Hope to see the S1000RR numbers soon.',
  bodyExtra: `
      <p style="color:#9ca3af;font-size:14px;line-height:1.7;margin-bottom:12px;">
        Your Shannonville session file, exported from AiM Race Studio as <strong style="color:#f97316;">CSV</strong>.
      </p>
      <p style="color:#9ca3af;font-size:14px;line-height:1.7;margin-bottom:12px;">
        And a correction to my first email: I asked you for the <strong style="color:#9ca3af;">.xrk</strong> file.
        That won't work — I can only read <strong style="color:#f9fafb;">CSV or GPX</strong>. So when you
        export from AiM, pick the CSV option.
      </p>
      <p style="color:#9ca3af;font-size:14px;line-height:1.7;margin-bottom:12px;">
        If your export has lateral and longitudinal G columns, keep them — that's what makes the
        cornering and braking advice genuinely useful. Without them I still get your line and speed,
        which is worth a look, but the coaching section will be thin. Either way, send it.
      </p>`
};

// ── Rex Gabriel ─────────────────────────────────────────────────────────────
// Suzuki GSX-R1000 (2013). Ran a phone lap-timer app; brand still unknown.
const REX = {
  to: 'Gabhubrex@gmail.com',
  firstName: 'Rex',
  kind: 'phone',
  subject: 'Rex — MotoTrackIQ follow-up (and my apologies for going quiet)',
  signOff: "Hope to see what the '13 GSX-R1000 is doing at your next outing.",
  bodyExtra: `
      <p style="color:#9ca3af;font-size:14px;line-height:1.7;margin-bottom:12px;">
        Still one thing I need from you: <strong style="color:#f97316;">which app were you running?</strong>
        TrackAddict, Harry's LapTimer, RaceChrono — any of those is fine.
      </p>
      <p style="color:#9ca3af;font-size:14px;line-height:1.7;margin-bottom:12px;">
        But honestly it doesn't matter as much as I thought: <strong style="color:#f9fafb;">CSV or GPX both work</strong>,
        and most of those apps export one from the share menu. <strong style="color:#f9fafb;">GPX is ideal</strong>
        if yours offers it — it carries GPS and altitude, and I can turn it into lap times and a
        racing line directly.
      </p>
      <p style="color:#9ca3af;font-size:14px;line-height:1.7;margin-bottom:12px;">
        If your export has lateral and longitudinal G columns, keep them — that's what makes the
        cornering and braking advice genuinely useful. Without them I still get your line and speed,
        which is worth a look, but the coaching section will be thin. Either way, send it.
      </p>`
};

const VALIDATION = {
  to: 'eacooke10@gmail.com',
  firstName: 'Everett',
  kind: 'aim',
  subject: '[VALIDATION] Maurice — MotoTrackIQ follow-up (and my apologies for going quiet)',
  signOff: 'Hope to see the S1000RR numbers soon.',
  bodyExtra: MAURICE.bodyExtra
};

// ── Preflight ───────────────────────────────────────────────────────────────
// Assert against the REAL html that ships (buildBetaInviteHtml is the exact
// string the sender transmits). A preview rebuilt from the per-rider paragraph
// alone silently misses the shared template — that is how "states
// confirm-email step" false-failed on the first pass even though the copy was
// correct. Check the shipped bytes, not a paraphrase.
function assertLead(lead) {
  const html = buildBetaInviteHtml(lead.firstName, {
    bodyExtra: lead.bodyExtra,
    signOff: lead.signOff
  });
  // Strip tags for prose checks; keep the raw html for structural checks.
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/—/g, '—')
    .replace(/“|”/g, '"')
    .replace(/&rarr;/g, '->')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
  const isAim = lead.kind === 'aim';

  const checks = {
    // No false claim that access exists / was provisioned.
    'no "access is ready" claim': !/access is ready|your access is set up|your account is ready/i.test(text),
    'no temp-password claim': !/temporary password|temp password|password:/i.test(text),
    'no credit-count claim': !/\b\d+\s*report credits?\b|\b\d+\s*credits\b/i.test(text),
    'no session-count claim': !/\b\d+\s*sessions?\b/i.test(text),
    'no false signup claim': !/you signed up|your spot on the waitlist|your account is set up/i.test(text),
    'no set-password instruction': !/set your password|create your password/i.test(text),
    // The consent path must be explicit.
    'points at waitlist form': /Join the Waitlist/.test(text) && /Beta/.test(text),
    'states Ontario limit': /Ontario residents only/i.test(text),
    'states confirm-email step': /confirmation email/i.test(text),
    // Format accuracy — this is the correction Maurice specifically needs.
    'says CSV or GPX': /CSV or GPX/.test(text),
    'corrects .xrk for Maurice': isAim ? /\.xrk/.test(text) : true,
    'asks app name for Rex': isAim ? true : /which app were you running/i.test(text),
    // Structural (raw html).
    'site url present': html.includes(SITE),
    'has CTA button': /linear-gradient\(135deg,#f97316/.test(html),
    'has logo img': /<img[^>]+logo-email\.png/.test(html),
    'no unescaped entity': !/&(mdash|nbsp|amp);/.test(html),
    'reply route present': /info@mototrackiq\.com/.test(html)
  };
  return checks;
}

const DRY = !!process.env.DRY_RUN;
const VALIDATE_ONLY = !!process.env.VALIDATE_ONLY;

const leads = VALIDATE_ONLY ? [VALIDATION] : [MAURICE, REX];

let failed = false;
for (const lead of leads) {
  const checks = assertLead(lead);
  const bad = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  console.log(`\n=== PREFLIGHT ${lead.firstName} -> ${lead.to}`);
  for (const [k, ok] of Object.entries(checks)) console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${k}`);
  if (bad.length) {
    failed = true;
    console.error(`   REFUSING TO SEND ${lead.firstName}: ${bad.join(', ')}`);
    continue;
  }
  if (DRY) {
    console.log(`   DRY RUN — would send "${lead.subject}"`);
    continue;
  }
  const res = await sendBetaInviteEmail(lead.to, lead.firstName, {
    subject: lead.subject,
    signOff: lead.signOff,
    bodyExtra: lead.bodyExtra
  });
  console.log(`   SEND: ${JSON.stringify(res)}`);
}

if (failed) process.exit(1);
console.log('\nDone.');
