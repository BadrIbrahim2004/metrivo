# Metrivo Local Activation on Cloudflare Workers

This Worker hosts only the Local activation endpoints:

- `GET /api/health`
- `POST /api/activation/request`
- `POST /api/activation/verify`

It reuses the existing Neon PostgreSQL database and the Google Apps Script
email relay. The free Cloudflare Workers plan has a daily request allowance
and Hyperdrive database-query allowance; see the official
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
and [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/).

## One-time setup

1. Install Node.js 20+ and npm. From this directory run `npm ci`.
2. Create/sign in to a Cloudflare account, then run `npx wrangler login`.
3. In Neon, open **Connect** for the dedicated `metrivo-activation` database
   and select the **direct** PostgreSQL connection string. Do not send it in
   chat or put it in a command, source file, or Git.
4. In the Cloudflare dashboard, create a **Hyperdrive** configuration for
   PostgreSQL and paste the Neon direct connection string there. Copy the
   resulting Hyperdrive ID into `wrangler.jsonc`, replacing
   `REPLACE_WITH_HYPERDRIVE_ID`.
5. Apply `migrations/activation-rate-limits.sql` to the same Neon database
   using its SQL Editor. The `LocalActivationChallenge` table should already
   exist there.
6. Deploy the Worker with `npm run deploy`. It will not issue activation
   codes until its secrets are set.
7. In the Worker's Cloudflare dashboard, open **Settings → Variables and
   Secrets** and add these as secrets:

   - `ACTIVATION_OWNER_EMAIL`
   - `ACTIVATION_OTP_PEPPER` (at least 32 bytes, freshly generated)
   - `ACTIVATION_SIGNING_PRIVATE_KEY_PEM` (the Ed25519 private key matching
     the public key in the Desktop app)
   - `ACTIVATION_MAIL_WEBHOOK_URL` (Google Apps Script `/exec` URL)
   - `ACTIVATION_MAILER_SHARED_SECRET` (same value as the Apps Script property)

   Enter each value only in Cloudflare's secret field. Never put secrets in
   `wrangler.jsonc`, source control, or chat. For the private key, paste the
   complete PEM including its BEGIN/END lines.
8. Check `https://<worker-name>.<account-subdomain>.workers.dev/api/health`.
   It should return `status: "ok"` and `database: "connected"`.
9. Redeploy after setting the secrets if the dashboard prompts you to.

The worker's rate-limit table is used for database-backed per-IP limits; the
request route additionally permits one code request per device per minute.
The verification route permits at most five incorrect OTP attempts. Codes
expire after five minutes and are single-use.

Do not use the exposed old signing key for customer activations. Before
production, rotate the Ed25519 key pair and update the Desktop public key and
installer together.
