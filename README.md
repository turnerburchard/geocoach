# GeoCoach

Records single-player no-move rounds and reviews them through your Codex login.

## Start

Requires Node 24+, pnpm, and the Codex CLI signed in with ChatGPT.

```sh
git clone https://github.com/turnerburchard/geocoach.git
cd geocoach
pnpm install
codex login
pnpm dev
```

Open **http://127.0.0.1:43821**. **Live recording** lists connected GeoGuessr tabs by browser, tab number, title, and URL. Choose **Setup** for installation instructions and a pairing code if the extension asks for one. On subsequent starts, `pnpm start` runs the existing build. `pnpm dev` rebuilds first.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on** and select `dist/extension-firefox/manifest.json`.
3. Open the GeoCoach extension, paste the pairing code from the review app, and click **Connect**.
4. Refresh the GeoGuessr page once after installation. Click the extension on that tab, then **Start recording this tab**.

Temporary Firefox add-ons must be loaded again after Firefox restarts. This build targets Firefox 128+.

### Chrome

1. Open `chrome://extensions` and enable Developer mode.
2. Click **Load unpacked** and select `dist/extension-chrome`.
3. Pair and start recording as described above.

Pairing is saved in the browser and in `.data/`, so closing tabs normally does not require another code. Recording is separate: start it on each new GeoGuessr tab. Recording needs one extension click per tab/session to grant `activeTab` access. Keep the local server running while you play.

Before playing, check the GeoCoach status at the bottom left of GeoGuessr. It reports recording off, waiting for a game, unsupported games, and connection errors. It only turns green after the server accepts a screenshot for the current game and round. The review app lists the same live status for each connected tab, including background tabs that are paused and the time of the last screenshot. Reports older than 15 seconds lose confirmation, and screenshots older than 20 seconds show a warning. Closed tabs are removed when the server is reachable, otherwise their reports expire. No manual screenshots are needed.

## Use

- Play single-player no move or NMPZ normally. Moving games and multiplayer are excluded.
- The extension samples the starting view, views after mouse/zoom/keyboard input settles, and periodic views while the round is active. It captures only the active GeoGuessr tab, crops to the Street View area, and skips exact duplicate images.
- When a round ends, **Review** appears on GeoGuessr. It opens the localhost app with that game and round selected. You can also review all completed rounds after the game.
- Use **Get help**, **I knew the country. How can I improve?**, or **This was mostly luck. What did I miss?** to request a review without typing. These work on any completed round and preserve your unsent custom draft. You can also explain your reasoning, ask what else was visible, or challenge the explanation. Each round has its own saved Codex conversation. New conversations start with up to six visually different captures chosen locally. For each question, the coach can make up to two inspection passes, each requesting up to six unseen views or crops combined. A crop isolates an area of a view the coach has already seen, using the saved pixels without inventing new detail. Crop evidence stays separate from the gameplay gallery, and citations link to the original view. Crops are kept locally with the round and deleted with the game. Follow-up questions receive a fresh inspection budget. Inspection can add model usage and delay before the answer. Existing conversations that already received all views keep their original context.
- New replies link their evidence to gallery views. Click a view citation to open that screenshot. All captures remain available in the gallery, whether or not they were sent to the coach.
- Learnable Meta text, links, and example-image URLs are collected when available. The coach receives its text and links alongside your actual scene captures. Reference images can be expanded in the review UI. The coach does not automatically download or inspect those external reference images.

## Boundaries and current limitations

There is no cloud service, account creation, API key requirement, automatic model call during play, or multiplayer integration. A model request starts only when you send a message about a completed round. This consumes your normal Codex allowance.

Automatic capture is sampling, not video. Pans can be missed if you guess immediately afterward, switch tabs, or stop the local server. A round keeps its first capture and up to 31 more recent distinct captures. Earlier intermediate views are removed when that limit is reached. The app does not reconstruct missed scenes or silently label result-map images as gameplay views.

GeoGuessr has no integration contract with this extension. The adapter observes classic game responses and uses the current Street View DOM label. Live capture against the current GeoGuessr UI must still be verified after loading the extension. Classic challenge snapshots are supported in the adapter but also need a live browser check. If a game is not recognized, the popup reports that rather than claiming it is capturing.

Learnable Meta cache matching uses its map and panorama keys when accessible. Userscript sandboxes may hide that cache, so the extension also reads displayed cards after rounds and cards opened through numbered result controls. It avoids guessing which round an already-open final-results card belongs to. Only context the script exposes or displays is collected. There is no reference-site crawling or independent fact database.

The coach is told to separate visible evidence, supplied references, and uncertainty. That is guidance to a fallible model, not a guarantee of correct niche metas. It does not automatically add flashcards or build a misconception profile.

## Local data and access

Games, chat transcripts, and cropped JPEGs live in `.data/`. The bridge listens only on `127.0.0.1:43821`, checks HTTP host and origin, and requires a local pairing secret for extension/API requests. The secret is not an OpenAI credential. Do not expose this port publicly.

Only requested completed-round reviews are sent to Codex. Codex uses its existing local login. The bridge ignores personal Codex config and repository instructions, disables shell tools and web search, and runs in a read-only sandbox from a dedicated local directory. It does not use `--dangerously-bypass-approvals-and-sandbox`.

Deleting a game removes its GeoCoach images and transcripts. Codex maintains its own session history separately, which deletion here does not erase. Unsent drafts are not saved. Learnable Meta image URLs are loaded by your browser only when you expand their reference card.

`GEOCOACH_DATA` can point to another local data directory. `GEOCOACH_CODEX` can point to a specific Codex executable. The port stays fixed because it is shared with the extension.

## Structure

```text
src/extension/page.ts         Observe game responses and available meta cache
src/extension/content.ts      Detect capture opportunities, read cards, add review link
src/extension/background.ts   Permission-checked capture and local bridge calls
src/extension/popup.ts        Pairing, recording toggle, and recognition diagnostics
src/server/index.ts           Local HTTP boundary, image processing, and review endpoints
src/server/store.ts           Local game/image metadata persistence
src/server/coach.ts           Codex process, prompt, per-round sessions, and failures
src/server/views.ts           Local image comparison and capped initial selection
src/shared/schema.ts          Validated extension/server request contracts
src/shared/recording.ts       Live tab status contracts and recording confirmation
src/web/                     Images, chat, and extension setup
```

The browser writes round results independently of image capture. The server refuses to coach an incomplete round and refuses to accept new gameplay captures after completion. Capture IDs make retries idempotent, and a second review request for the same running round is rejected. File metadata writes are atomic. Interrupted replies become recoverable errors on restart.

## Verify

```sh
pnpm test
pnpm lint
pnpm type-check
pnpm build
pnpm test:codex
```

`test:codex` runs a real subscription-backed review of a synthetic blue triangle, requests a crop, then resumes the saved conversation to check image inspection and memory. It is separate from the ordinary test suite so routine tests do not consume model usage.

Before considering capture verified, load the extension and play a real no-move game. Check the starting view, a panned view, an immediate guess, a tab switch, multiple rounds, optional Learnable Meta, and the final results. Verify round selection and context, then ask a follow-up in two different rounds to check conversation isolation.

## Integration references

- [Chrome capture and permissions](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab)
- [Firefox background scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background)
- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [GeoGuessr Event Framework](https://github.com/miraclewhips/geoguessr-event-framework), consulted for classic-game response structure
- [Learnable Meta](https://github.com/likeon/geometa), consulted for card selectors and cache keys

This app observes its own browser data and DOM. It does not bundle Learnable Meta or GeoGuessr Event Framework code.
