import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { webcrypto } from "node:crypto";

type Listener = (
	message: unknown,
	sender: unknown,
	respond: (result: unknown) => void,
) => boolean;

test("page bridge preserves fetch responses and matches cached metas only to completed rounds", async () => {
	const bundle = await build({
		entryPoints: ["src/extension/page.ts"],
		bundle: true,
		write: false,
		format: "iife",
		platform: "browser",
	});
	const events: {
		type: string;
		round?: number;
		meta?: { title: string };
		state?: { completed: unknown[] };
	}[] = [];
	let snapshot: (() => Promise<void>) | undefined;
	let payload = {
		token: "abc",
		round: 2,
		mapName: "Practice",
		forbidMoving: true,
		rounds: [
			{ lat: 1, lng: 1, panoId: "pano-one" },
			{ lat: 2, lng: 2, panoId: "pano-two" },
		],
		player: { guesses: [{ lat: 3, lng: 3 }] },
	};
	const pageWindow = {
		fetch: async (_input?: unknown) => Response.json(payload),
		postMessage: (event: (typeof events)[number]) => events.push(event),
		geometaMetaCache: new Map([
			[
				"map1_pano-one",
				{ country: "Portugal", metaName: "First lesson", note: "<p>One</p>" },
			],
			[
				"map1_pano-two",
				{ country: "Belgium", metaName: "Second lesson", note: "<p>Two</p>" },
			],
		]),
	};
	const document = {
		querySelector: () => ({ href: "https://learnablemeta.com/maps/map1" }),
	};
	class Parser {
		parseFromString(html: string) {
			return {
				body: { textContent: html.replace(/<[^>]*>/g, "") },
				querySelectorAll: () => [],
			};
		}
	}
	runInNewContext(bundle.outputFiles[0].text, {
		window: pageWindow,
		document,
		location: {
			origin: "https://www.geoguessr.com",
			pathname: "/game/abc",
			href: "https://www.geoguessr.com/game/abc",
		},
		URL,
		Request,
		DOMParser: Parser,
		setInterval: (callback: () => Promise<void>) => {
			snapshot = callback;
		},
	});
	const response = await pageWindow.fetch("/api/v3/games/abc");
	assert.equal((await response.json()).token, "abc");
	await new Promise((resolve) => setImmediate(resolve));
	if (!snapshot) throw new Error("Snapshot timer missing");
	await snapshot();
	assert.deepEqual(
		events.filter((e) => e.type === "meta").map((e) => e.meta?.title),
		["Portugal - First lesson"],
	);
	assert.equal(
		events.find((e) => e.type === "state")?.state?.completed.length,
		1,
	);
	payload = {
		...payload,
		player: {
			guesses: [
				{ lat: 3, lng: 3 },
				{ lat: 4, lng: 4 },
			],
		},
	};
	await pageWindow.fetch("/api/v3/games/abc");
	await new Promise((resolve) => setImmediate(resolve));
	await snapshot();
	await snapshot();
	assert.deepEqual(
		events.filter((e) => e.type === "meta").map((e) => e.round),
		[1, 2],
	);
	assert.equal(
		events.filter((e) => e.type === "meta").at(-1)?.meta?.title,
		"Belgium - Second lesson",
	);
});
test("extension only captures the enabled active GeoGuessr tab and rechecks it after capture", async () => {
	const bundle = await build({
		entryPoints: ["src/extension/background.ts"],
		bundle: true,
		write: false,
		format: "iife",
		platform: "browser",
	});
	const storage: Record<string, unknown> = { token: "test-token" };
	const posts: { url: string; body: string }[] = [];
	let listener: Listener | undefined;
	let active = true,
		valid = true,
		captures = 0;
	let captureError: string | undefined;
	let badge = "";
	const chrome = {
		storage: {
			local: {
				get: async (key: string | string[]) =>
					Object.fromEntries(
						(typeof key === "string" ? [key] : key).map((k) => [k, storage[k]]),
					),
				set: async (values: object) => Object.assign(storage, values),
				remove: async (key: string) => {
					delete storage[key];
				},
			},
		},
		runtime: {
			id: "test-extension",
			getURL: () => "chrome-extension://test-extension/",
			onMessage: {
				addListener: (value: Listener) => {
					listener = value;
				},
			},
			onStartup: { addListener: () => {} },
		},
		tabs: {
			get: async () => ({ active }),
			captureVisibleTab: async () => {
				captures++;
				if (captureError) throw new Error(captureError);
				return "data:image/jpeg;base64,YQ==";
			},
			sendMessage: async () => valid,
			onRemoved: { addListener: () => {} },
		},
		action: {
			setBadgeText: async ({ text }: { text: string }) => {
				badge = text;
			},
			setBadgeBackgroundColor: async () => {},
		},
	};
	runInNewContext(bundle.outputFiles[0].text, {
		chrome,
		crypto: webcrypto,
		URL,
		AbortSignal,
		setTimeout,
		clearTimeout,
		fetch: async (url: string, options: { body: string }) => {
			posts.push({ url, body: options.body });
			return { ok: true, json: async () => ({ ok: true, stored: true }) };
		},
	});
	const sender = {
		tab: { id: 7, windowId: 1, url: "https://www.geoguessr.com/game/abc" },
	};
	const message = {
		type: "capture",
		input: {
			gameId: "abc",
			mapName: "Practice",
			round: 1,
			captureId: "b8a89b38-491f-4bfa-80ae-735cd4e209ee",
			capturedAt: new Date().toISOString(),
			reason: "start",
		},
	};
	const send = (value: unknown, from: unknown = sender) =>
		new Promise<unknown>((resolve) => {
			if (!listener) throw new Error("Listener not installed");
			listener(value, from, resolve);
		});
	await send(message);
	assert.equal(captures, 0);
	storage["recording:7"] = true;
	active = false;
	await send(message);
	assert.equal(captures, 0);
	await send(message, { tab: { id: 7, url: "https://example.com" } });
	assert.equal(captures, 0);
	active = true;
	valid = false;
	await send(message);
	assert.equal(captures, 1);
	assert.equal(posts.length, 0);
	await new Promise((resolve) => setTimeout(resolve, 710));
	valid = true;
	await send(message);
	assert.equal(captures, 2);
	assert.equal(posts.length, 1);
	assert.equal(posts[0].url, "http://127.0.0.1:43821/api/captures");
	assert.equal(JSON.parse(posts[0].body).gameId, "abc");
	await new Promise((resolve) => setTimeout(resolve, 710));
	captureError = "Missing activeTab permission";
	await send(message);
	assert.equal(storage["recording:7"], true);
	assert.equal(storage["error:7"], "Click GeoCoach to resume screenshots.");
	assert.equal(badge, "PAUSE");
	await new Promise((resolve) => setTimeout(resolve, 710));
	captureError = undefined;
	await send(message);
	assert.equal(storage["error:7"], undefined);
	assert.equal(badge, "REC");
	const page = {
		recognized: true,
		supported: true,
		visible: true,
		gameId: "abc",
		activeRound: 1,
		completed: 0,
	};
	const status = (await send({ type: "recording-status", page })) as {
		recording: boolean;
	};
	assert.equal(status.recording, true);
	const firstTab = JSON.parse(posts.at(-1)?.body ?? "{}");
	assert.equal(firstTab.tabId, 7);
	storage["recording:8"] = true;
	const other = (await send(
		{ type: "recording-status", page },
		{ tab: { ...sender.tab, id: 8 } },
	)) as { recording: boolean };
	assert.equal(other.recording, false);
	const secondTab = JSON.parse(posts.at(-1)?.body ?? "{}");
	assert.notEqual(firstTab.id, secondTab.id);
	assert.equal(secondTab.lastCapture, undefined);
});
