# Dotopia website membership access

## Current implementation

- Successful new membership and renewal fulfillment issue a fresh one-time website code.
- Only a SHA-256 hash of each invitation code is stored.
- Codes are linked to the membership record and expire at the membership end.
- Redeeming a code atomically marks it used and creates a random server-side session.
- Session cookies are HttpOnly, Secure and SameSite=None.
- Every session check re-reads the membership status and expiry from SQLite.
- Existing Telegram private-channel invitations and Razorpay payment handling remain in place.

## Required Render environment

Set:

- `WEBSITE_ORIGIN`: exact public website origin, including scheme, e.g. `https://members.example.com`.

The browser is configured to call the API on the same origin using relative `/api/website/*` paths. Cloudflare Worker must proxy those paths to `https://dotopia-telegram-bot.onrender.com`.

The browser sends credentialed requests. Cross-origin cookies can be blocked by browsers when the website and API are on unrelated registrable domains. The Worker must proxy `/api/website/*` to Render and preserve request method, body, cookies, and response Set-Cookie headers. This keeps the browser session same-origin and avoids third-party-cookie restrictions. Do not expose Render secrets in the Worker.

## Important deployment notes

1. Keep the existing persistent SQLite volume. The invitation and session tables are created automatically on server startup.
2. Set `WEBSITE_ORIGIN` in Render before testing redemption.
3. Deploy the backend and website from the feature branch only after reviewing the changes.
4. Test with a real successful payment in a controlled manner; verify a code is delivered, redeem it once, confirm a second redemption fails, and confirm expired memberships are rejected.
5. The members page is currently an authenticated shell. Premium media delivery and the admin upload workflow are not implemented yet. Do not place premium media in public static folders or in the Git repository. Add private R2 storage and authenticated media delivery before uploading real content.
6. No screenshot or screen-recording prevention is guaranteed by this web implementation.

## API

- `POST /api/website/redeem` — body: `{"code":"ONE_TIME_CODE"}`; redeems code and sets session cookie.
- `GET /api/website/me` — checks session and current membership.
- `POST /api/website/logout` — revokes current session.
