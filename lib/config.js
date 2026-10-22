/**
 * Central config loader for MotoTrackIQ backend v2.
 *
 * WHY THIS EXISTS (Oct 22, 2026 security fix):
 * The JWT secret previously had a hardcoded fallback of
 * '<REDACTED-JWT-LITERAL>' in FOUR places. That value is committed
 * to a PUBLIC GitHub repo, so it is effectively a well-known constant. The
 * server only used a real secret if the env var happened to be set; otherwise
 * it silently fell back to the public value and accepted tokens forged by
 * anyone. A secret that is "optional" is not a secret.
 *
 * RULES ENFORCED HERE:
 *  1. Secrets are REQUIRED. No default, no fallback, no placeholder. If a
 *     secret is missing the process refuses to start rather than serve with
 *     a guessable key.
 *  2. .env is loaded explicitly (the app never did this before, so a local
 *     .env existed but was never read — the hardcoded fallback was silently
 *     winning).
 *  3. Values that are genuinely optional (feature toggles, brand names) keep
 *     sane defaults; only real secrets fail closed.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Load .env from the service root if present. Never overrides variables that
 * are already set in the real environment (Railway, PM2, systemd) — a real
 * environment must always win over a stray file on disk.
 */
function loadEnvFile() {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;

  try {
    // Node's built-in loader (Node 20.12+/21+). It does not overwrite
    // already-set variables, which is exactly the precedence we want.
    process.loadEnvFile(envPath);
  } catch {
    // Fallback: minimal parser for older runtimes.
    try {
      const raw = fs.readFileSync(envPath, 'utf8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (key && process.env[key] === undefined) process.env[key] = val;
      }
    } catch (err) {
      console.error(`[config] could not parse .env: ${err.message}`);
    }
  }
}

loadEnvFile();

/**
 * Return a required secret, or exit the process with a clear message.
 * A hard failure is the point: a server that starts with a guessable
 * signing key is worse than a server that is visibly down.
 */
function requireSecret(name) {
  const val = process.env[name];
  if (!val || !val.trim()) {
    console.error(
      `\n[config] FATAL: required environment variable ${name} is not set.\n` +
        `        This service will not start with a missing secret.\n` +
        `        Set ${name} in the environment (Railway dashboard / PM2 env / .env).\n`
    );
    process.exit(1);
  }
  return val.trim();
}

/** Optional string with a safe default (non-secret values only). */
function optional(name, fallback = '') {
  const val = process.env[name];
  return val && val.trim() ? val.trim() : fallback;
}

export const config = {
  port: parseInt(optional('PORT', '3009'), 10),
  nodeEnv: optional('NODE_ENV', 'development'),

  // REQUIRED secrets — fail closed if absent.
  get jwtSecret() {
    return requireSecret('JWT_SECRET');
  },
  get reportLinkSecret() {
    return process.env.REPORT_LINK_SECRET?.trim() || this.jwtSecret;
  },
  // ADMIN_KEY is optional here on purpose: the admin gate itself already
  // fails closed when it is unset (returns 503 "Admin access not
  // configured"). Requiring it at startup would break local dev instances
  // that have no admin surface enabled.
  get adminKey() {
    return optional('ADMIN_KEY');
  },

  // Optional integration secrets.
  lsWebhookSecret: optional('LS_WEBHOOK_SECRET'),
  lsApiKey: optional('LEMONSQUEEZY_API_KEY'),
  googleClientSecret: optional('GOOGLE_CLIENT_SECRET'),
  googleRefreshToken: optional('GOOGLE_REFRESH_TOKEN'),

  fromEmail: optional('FROM_EMAIL'),
  fromName: optional('FROM_NAME', 'MotoTrackIQ'),
  gmailUser: optional('GMAIL_USER'),
  smtpUser: optional('SMTP_USER'),
  smtpPass: optional('SMTP_PASS'),
};

export default config;
