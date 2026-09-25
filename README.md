# Burning Paper

Burning Paper shares encrypted text in two ways:

- **Sealed Letter:** a one-time link that expires after 24 hours.
- **Whisper:** a direct transfer while both browsers are online.

The browser encrypts and decrypts the message. Astro serves the page, and a Cloudflare Worker handles the API. There are no accounts or file uploads.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/CarloBu/burning-paper)

The button copies the repository and deploys it. `wrangler.jsonc` configures storage; no application secrets or separate database setup are required.

For local deployment, use Node.js 24 and pnpm 11.5.1:

```powershell
pnpm.cmd install
pnpm.cmd exec wrangler login
pnpm.cmd deploy
```

This builds `dist/` and deploys the page and API as the `burning-paper` Worker. Open Wrangler's HTTPS URL or attach a custom domain. If Cloudflare selects pnpm 10, set the build variable `PNPM_VERSION=11.5.1`.

Keep analytics, Zaraz, Rocket Loader, third-party scripts, and page transformations off. Preserve the app's `no-store` headers.

## Develop

```powershell
pnpm.cmd install
pnpm.cmd dev
```

Open Wrangler's local URL, normally `http://localhost:8787`. This builds the page and serves it with the API through one local Worker. Use dummy secrets.

Run `pnpm.cmd build` after UI edits to refresh the static assets. `pnpm.cmd dev:worker` serves an existing build. For UI-only live updates, use `pnpm.cmd dev:ui`; Astro's default dev server does not serve or proxy the API. Production security headers apply through the Worker.

## Sealed Letter

1. The browser encrypts up to 4,096 UTF-8 bytes using AES-256-GCM, a fresh 256-bit key, a 96-bit IV, and a 128-bit authentication tag.
2. Only ciphertext and the IV are uploaded. The random retrieval ID and key are shared as `/#id.key`. Browsers [do not send URL fragments in HTTP requests](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment).
3. The recipient page removes the fragment, validates the link, and waits for **Reveal once**. A transaction retrieves and deletes the ciphertext before responding; at most one retrieval succeeds. Decryption happens locally.
4. Unopened records expire after 24 hours, even if scheduled cleanup fails.

Deletion precedes delivery: a network or decryption failure can permanently consume the link. There are no automatic retries or recovery copies. Ordinary link previews do not consume it, but a scanner that clicks Reveal can. Someone with only the retrieval ID can consume the message without decrypting it.

## Whisper

Choose **try Whisper**, keep the sender's tab open, and have the recipient click **Receive whisper** within 10 minutes. Both browsers must remain connected.

A separate Durable Object forwards connection descriptions and heartbeats over WebSockets. Its session state stays in memory; restarting it loses the session. The browsers derive separate encryption and authentication keys with HKDF-SHA-256 and authenticate WebRTC descriptions using HMAC-SHA-256. The AES-256-GCM encrypted note travels over a direct WebRTC data channel, never through the signaling service.

The recipient acknowledges delivery, then the sender clears its state. Each session sends once. If the acknowledgement is lost, the sender reports that delivery could not be confirmed and does not retry. The delivery status confirms receipt by the browser; it cannot tell whether someone read the message.

Whisper uses [Cloudflare STUN](https://developers.cloudflare.com/realtime/turn/) with no TURN relay or automatic storage fallback. Some networks cannot connect directly. Connection setup times out after 30 seconds; acknowledgement after 15 seconds. Cancellation, disconnection, expiry, or leaving the page ends the session. Create a new Sealed Letter if needed. Active signaling sockets can incur Durable Object duration charges.

## Clearing and security limits

Anyone with the complete link can read the message. Share links privately. The app has not had an independent security audit.

- **Copy & burn** copies a Sealed Letter before burning; **Burn now** starts manually. Text remains visible during burning and clears on completion or failure. Automatic burning starts after 60 seconds.
- Whisper's **Copy & clear** and **Let it go** both copy before clearing. Received text clears automatically after 15 seconds, followed by the air effect. Failed copying leaves text available until its deadline.
- Page exit and Back/Forward restoration clear text; visibility changes recheck deadlines. Browser suspension can delay cleanup, and exit events are not guaranteed. Reduced motion skips animations. Canvas never receives secret text; temporary animation copies are wiped.
- Deleting live Sealed Letter records does not erase provider backups. Durable Objects support [30-day point-in-time recovery](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api). Do not restore consumed records into the serving namespace. Whisper does not persist messages.
- A compromised browser, hosting account, or recipient device can expose messages. Clearing cannot erase clipboard history, screenshots, or other copies, and JavaScript cannot guarantee that every copy is removed from memory.
- Encryption does not hide message length, IP addresses, or timing. Signaling sees connection descriptions; direct peers may learn each other's public IP addresses. Whisper does not provide anonymity.

The API requires same-origin JSON POSTs, limits bodies to 8,192 bytes, and never consumes messages on GET or HEAD. Whisper allows one sender and recipient, signaling frames up to 24,000 bytes, and one offer/answer pair with 16,384-byte SDP limits. Both modes share an eventually consistent per-IP limit of 30 requests per minute per Cloudflare location. Distributed abuse remains possible.

The app uses no analytics, browser storage, cookies, or service workers. Responses include CSP, `no-referrer`, `noindex`, and `no-store`. Disabling Worker observability does not eliminate provider logging; `robots.txt` is not access control.

## Checks

```powershell
pnpm.cmd test
pnpm.cmd check
```

Tests run in the Workers runtime and cover one-time retrieval, concurrent requests, expiry, restarts, request limits, headers, and signaling. Neither command runs a build.

Before publishing, test with dummy secrets:

- Unicode and HTML-shaped text must remain literal; malformed links must not fetch secrets.
- Check clipboard denial, burning, reduced motion, timeouts, background tabs, and Back/Forward cleanup.
- Test Whisper in two browsers and on different networks: receipt, acknowledgement, cancellation, wrong keys, competing recipients, disconnection, and lost acknowledgement.
- Confirm Whisper never calls the storage API or sends keys or note payloads through signaling.
- Verify production headers, caching, script injection, logging, and abuse/cost controls. Backend tests do not verify browser behavior or hosting settings.
