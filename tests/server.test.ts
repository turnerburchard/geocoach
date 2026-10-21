import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import sharp from "sharp";
import { Store } from "../src/server/store";
import { review } from "../src/server/coach";

process.env.GEOCOACH_TEST = "1";
const { createApp } = await import("../src/server/index");
const result = {
	actual: { lat: 38.5, lng: -7.9 },
	guess: { lat: 43.6, lng: 1.4 },
	score: 2638,
	distanceMeters: 1008000,
};

async function fetchHttp(url: string, options: RequestInit = {}) {
	return new Promise<Response>((resolve, reject) => {
		const request = httpRequest(
			url,
			{
				method: options.method ?? "GET",
				headers: options.headers as Record<string, string>,
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk) => chunks.push(chunk));
				response.on("end", () =>
					resolve(
						new Response(Buffer.concat(chunks), {
							status: response.statusCode,
							headers: response.headers as Record<string, string>,
						}),
					),
				);
			},
		);
		request.on("error", reject);
		request.end(options.body);
	});
}

test("HTTP ingestion, crop, deduplication, completion gate, auth, and deletion", async () => {
	const root = await mkdtemp(join(tmpdir(), "geocoach-http-"));
	const { app, store } = createApp(join(root, ".data"));
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("No HTTP address");
	const base = `http://127.0.0.1:${address.port}`;
	const request = (path: string, options: RequestInit = {}) =>
		fetchHttp(base + path, {
			...options,
			headers: {
				Host: "127.0.0.1:43821",
				Authorization: `Bearer ${store.token}`,
				"Content-Type": "application/json",
				...options.headers,
			},
		});
	try {
		assert.equal(
			(
				await fetchHttp(`${base}/api/games`, {
					headers: { Host: "127.0.0.1:43821" },
				})
			).status,
			401,
		);
		assert.equal(
			(
				await request("/api/session", {
					headers: { Origin: "https://evil.example" },
				})
			).status,
			403,
		);
		assert.equal(
			(
				await request("/api/session", {
					headers: { Origin: "moz-extension://fake-extension" },
				})
			).status,
			403,
		);
		assert.equal(
			(await request("/api/games", { headers: { Host: "evil.example:43821" } }))
				.status,
			403,
		);
		assert.equal(
			(
				await request("/api/rounds", {
					method: "POST",
					body: JSON.stringify({ gameId: "../escape", round: 1, mapName: "x" }),
				})
			).status,
			400,
		);
		const liveTab = {
			id: "profile-a:7",
			tabId: 7,
			browser: "Firefox",
			title: "First game",
			url: "https://www.geoguessr.com/game/game1",
			enabled: true,
			visible: true,
			recognized: false,
			supported: false,
			activeRound: null,
			completed: 0,
		};
		assert.equal(
			(
				await request("/api/recording", {
					method: "POST",
					body: JSON.stringify(liveTab),
				})
			).status,
			200,
		);
		await request("/api/recording", {
			method: "POST",
			body: JSON.stringify({
				...liveTab,
				id: "profile-b:7",
				title: "Second browser",
			}),
		});
		const tabs = await (await request("/api/recording")).json();
		assert.equal(tabs.length, 2);
		assert.equal(tabs[0].title, "First game");
		assert.equal(typeof tabs[0].seenAt, "number");
		await request("/api/recording/profile-a:7", { method: "DELETE" });
		assert.equal((await (await request("/api/recording")).json()).length, 1);
		assert.equal(
			(
				await request("/api/recording", {
					method: "POST",
					body: JSON.stringify({ ...liveTab, url: "https://evil.example" }),
				})
			).status,
			400,
		);

		await request("/api/rounds", {
			method: "POST",
			body: JSON.stringify({ gameId: "game1", round: 1, mapName: "Practice" }),
		});
		assert.equal(
			(
				await request("/api/games/game1/rounds/1/chat", {
					method: "POST",
					body: JSON.stringify({ question: "Help" }),
				})
			).status,
			409,
		);
		const png = await sharp({
			create: { width: 300, height: 200, channels: 3, background: "#345643" },
		})
			.png()
			.toBuffer();
		const capture = {
			gameId: "game1",
			mapName: "Practice",
			round: 1,
			captureId: randomUUID(),
			image: `data:image/png;base64,${png.toString("base64")}`,
			capturedAt: new Date().toISOString(),
			reason: "start",
			rect: {
				x: 10,
				y: 20,
				width: 150,
				height: 100,
				viewportWidth: 300,
				viewportHeight: 200,
			},
		};
		assert.equal(
			(
				await request("/api/captures", {
					method: "POST",
					body: JSON.stringify(capture),
				})
			).status,
			200,
		);
		assert.equal(
			(
				await request("/api/captures", {
					method: "POST",
					body: JSON.stringify({ ...capture, captureId: randomUUID() }),
				})
			).status,
			200,
		);
		assert.equal(store.round("game1", 1)?.captures.length, 1);
		const [file] = await readdir(join(store.root, "images"));
		const metadata = await sharp(join(store.root, "images", file)).metadata();
		assert.equal(metadata.width, 150);
		assert.equal(metadata.height, 100);
		assert.equal((await request(`/api/images/${file}`)).status, 200);
		const session = await request("/api/session");
		const cookie = session.headers.get("set-cookie")?.split(";")[0] ?? "";
		assert.equal(
			(
				await request(`/api/images/${file}`, {
					headers: { Authorization: "", Cookie: cookie },
				})
			).status,
			200,
		);
		await request("/api/rounds", {
			method: "POST",
			body: JSON.stringify({
				gameId: "game1",
				round: 1,
				mapName: "Practice",
				result,
			}),
		});
		await request("/api/captures", {
			method: "POST",
			body: JSON.stringify({ ...capture, captureId: randomUUID() }),
		});
		assert.equal(store.round("game1", 1)?.captures.length, 1);
		const reloaded = new Store(store.root);
		assert.deepEqual(reloaded.round("game1", 1)?.result, result);
		assert.equal(
			(await request("/api/games/game1", { method: "DELETE" })).status,
			200,
		);
		assert.equal(store.list().length, 0);
		assert.equal((await readdir(join(store.root, "images"))).length, 0);
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((e) => (e ? reject(e) : resolve())),
		);
		await rm(root, { recursive: true, force: true });
	}
});

test("Codex runner saves thread IDs, resumes the correct round, and reports failures", async () => {
	const root = await mkdtemp(join(tmpdir(), "geocoach-runner-"));
	const oldExecutable = process.env.GEOCOACH_CODEX;
	const executable = join(root, "fake-codex");
	await writeFile(
		executable,
		`#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  const resumed = process.argv.includes('resume');
  console.log(JSON.stringify({type:'thread.started',thread_id:'test-thread-id'}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({answer:resumed?'Follow-up remembered.':'First reply.',inspect:[]})}}));
  console.log(JSON.stringify({type:'turn.completed'}));
});
`,
		{ mode: 0o700 },
	);
	process.env.GEOCOACH_CODEX = executable;
	try {
		const store = new Store(root);
		const round = store.upsert({
			gameId: "g",
			mapName: "Practice",
			round: 1,
			result,
		});
		const game = store.game("g");
		if (!game) throw new Error("Missing game");
		await review(store, game, round, "First question", () => {});
		assert.equal(round.threadId, "test-thread-id");
		assert.equal(round.reviewStatus, "idle");
		await review(store, game, round, "What else?", () => {});
		assert.equal(round.messages.at(-1)?.text, "Follow-up remembered.");
		assert.equal(round.messages.length, 4);
		const other = store.upsert({
			gameId: "g",
			mapName: "Practice",
			round: 2,
			result,
		});
		assert.equal(other.threadId, undefined);
		process.env.GEOCOACH_CODEX = join(root, "missing-codex");
		await review(store, game, other, "Question", () => {});
		assert.equal(other.reviewStatus, "error");
		assert.match(other.error ?? "", /ENOENT/);
		round.reviewStatus = "running";
		store.save();
		assert.equal(new Store(root).round("g", 1)?.reviewStatus, "error");
	} finally {
		if (oldExecutable) process.env.GEOCOACH_CODEX = oldExecutable;
		else delete process.env.GEOCOACH_CODEX;
		await rm(root, { recursive: true, force: true });
	}
});
