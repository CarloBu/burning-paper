# Implementation notes

The app is an Astro page with a Cloudflare Worker. It uses browser Web Crypto and native WebRTC, without a client framework, accounts, or file uploads.

`src/worker.js` handles Sealed Letter creation and retrieval. Each message has its own Durable Object, which stores ciphertext, an IV, and a 24-hour expiry. Retrieval reads and deletes the record in one transaction before responding. A lost response can therefore consume the link. Expiry is checked on reads as well as by the cleanup alarm.

`src/scripts/crypto.js` encrypts with AES-256-GCM using a fresh 256-bit key and 96-bit IV. The key stays in the URL fragment and never goes to the API. Both link tokens must pass validation before Reveal is enabled. Text is limited to 4,096 UTF-8 bytes.

`src/whisper-room.js` exchanges connection descriptions over WebSockets and keeps room state in memory. The browser authenticates those descriptions, then sends the encrypted note through a WebRTC data channel. Sessions expire after 10 minutes. Each session sends once and waits for acknowledgement.

`src/scripts/app.js` manages the form, sharing links, clipboard controls, and clearing. Sealed Letters clear after burning; Whisper clears before its air effect. Page exit, expiry, and Back/Forward restoration also clear text. Animation code lives in `paper-motion.js` and `whisper-air.js`.

Run `pnpm.cmd test` for backend tests and `pnpm.cmd check` for JavaScript syntax. Use the README checklist for browser and deployment checks. Server deletion does not erase provider backups, and browser cleanup cannot erase recipient copies.
