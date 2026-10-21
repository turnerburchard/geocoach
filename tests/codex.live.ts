import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { Store } from "../src/server/store";
import { review } from "../src/server/coach";

const root = await mkdtemp(join(tmpdir(), "geocoach-codex-live-"));
try {
	const store = new Store(root);
	const round = store.upsert({
		gameId: "connection-test",
		mapName: "Synthetic connection test",
		round: 1,
		result: {
			actual: { lat: 0, lng: 0 },
			guess: null,
			score: 0,
			distanceMeters: null,
		},
	});
	const image = await sharp(
		Buffer.from(
			'<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="white"/><path d="M1000 550 1100 750 900 750Z" fill="blue"/></svg>',
		),
	)
		.jpeg()
		.toBuffer();
	await writeFile(join(root, "images", "test.jpg"), image);
	round.captures.push({
		id: "test",
		file: "test.jpg",
		reason: "start",
		capturedAt: new Date().toISOString(),
	});
	const game = store.game("connection-test");
	if (!game) throw new Error("Missing test game");
	await review(
		store,
		game,
		round,
		'This is an image inspection integration test, not a geography question. Before answering, request a zoom of View 1 using region {"x":0.65,"y":0.6,"width":0.3,"height":0.35}. After receiving that crop, tell me the shape and color inside it in one sentence.',
		() => {},
	);
	assert.equal(round.reviewStatus, "idle", round.error);
	assert.match(round.messages.at(-1)?.text ?? "", /blue/i);
	assert.match(round.messages.at(-1)?.text ?? "", /triangle/i);
	assert.ok(round.threadId);
	assert.equal(round.coachImages?.crops?.length, 1);
	assert.equal(round.captures.length, 1);
	console.log(
		"PASS: requested crop returned a blue triangle without adding a gallery view.",
	);
	const reloaded = new Store(root);
	const savedGame = reloaded.game("connection-test");
	const savedRound = reloaded.round("connection-test", 1);
	if (!savedGame || !savedRound) throw new Error("Missing saved test round");
	await review(
		reloaded,
		savedGame,
		savedRound,
		"From the cropped view you inspected in my previous message, what color was the shape? Answer in one sentence.",
		() => {},
	);
	assert.equal(savedRound.reviewStatus, "idle", savedRound.error);
	assert.match(savedRound.messages.at(-1)?.text ?? "", /blue/i);
	console.log("PASS: saved conversation resumed and remembered the crop.");
} finally {
	await rm(root, { recursive: true, force: true });
}
