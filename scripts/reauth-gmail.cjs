/**
 * Gmail OAuth re-authorization (headless / copy-paste flow)
 *
 * Usage:
 *   1) node scripts/reauth-gmail.js           -> prints the Google auth URL
 *   2) Open URL, sign in as the sending account, approve
 *   3) Browser redirects to http://localhost/?code=XXXX (page won't load — that's fine)
 *   4) Copy the `code` value from the address bar
 *   5) node scripts/reauth-gmail.js "PASTE_CODE_HERE"
 *      -> exchanges code, prints the refresh_token, writes config/token.json
 */
'use strict';

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const CREDENTIALS_PATH = path.join(CONFIG_DIR, 'credentials.json');
const TOKEN_PATH = path.join(CONFIG_DIR, 'token.json');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
];

const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
const inst = creds.installed || creds.web || creds;
const { client_id, client_secret } = inst;

// Use the classic OOB-friendly localhost redirect (already registered on this client).
const REDIRECT = 'http://localhost';
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT);

const code = process.argv[2];

if (!code) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',       // force a fresh refresh_token
    scope: SCOPES,
  });
  console.log('\n=== STEP 1: Open this URL, sign in, approve ===\n');
  console.log(authUrl);
  console.log('\nAfter approving you will be redirected to http://localhost/?code=...');
  console.log('The page will fail to load — that is expected. Copy the value of `code` from the address bar.');
  console.log('Then run: node scripts/reauth-gmail.js "THE_CODE"\n');
} else {
  (async () => {
    try {
      const { tokens } = await oAuth2Client.getToken(decodeURIComponent(code));
      if (!tokens.refresh_token) {
        console.error('\n[!] No refresh_token returned. Re-run step 1 (must use prompt=consent) and try again.\n');
        process.exit(1);
      }
      // Persist full token for local use
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
      console.log('\n=== SUCCESS ===');
      console.log('Wrote', TOKEN_PATH);
      console.log('\nGOOGLE_REFRESH_TOKEN=' + tokens.refresh_token + '\n');
    } catch (err) {
      console.error('\n[!] Token exchange failed:', err.message);
      process.exit(1);
    }
  })();
}
