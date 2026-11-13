# Free activation email relay

This Google Apps Script relays activation emails through the Google account
that owns the script. It does not need a custom domain or an email password.
The deployment is publicly reachable, but it accepts messages only when the
request has a valid HMAC signature made with a secret shared with the API.

## Set up the relay

1. Sign in to the Google account that should send activation email and create a
   project at <https://script.google.com/>.
2. Replace the starter contents of `Code.gs` with the contents of the
   repository's `Code.gs`.
3. In **Project Settings**, add a Script Property named
   `METRIVO_MAILER_SHARED_SECRET`. Use a unique random value of at least 32
   bytes. Store the exact same value in the API host's
   `ACTIVATION_MAILER_SHARED_SECRET` environment variable. Do not commit or
   send this secret in chat.
4. Deploy as a **Web app**, choose **Execute as me**, and allow access to
   **Anyone**. Google prompts you to authorize the script to send email.
5. Copy the deployed `/exec` URL into the API host's
   `ACTIVATION_MAIL_WEBHOOK_URL` environment variable. Keep the URL private
   where practical; the HMAC check remains required even if it is disclosed.

The script rejects unsigned, expired, malformed, and stale requests. The API
signs the recipient, six-digit code, expiry, and request timestamp; the
signature is checked before sending.

Google account email quotas and anti-abuse limits apply and can change. Test
delivery to the configured activation owner email before building an installer.
