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
			'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="white"/><path d="M320 50 550 350 90 350Z" fill="blue"/></svg>',
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
		"This is a connection test, not a geography question. In one sentence, what shape and color are in the attached test image?",
		() => {},
	);
	assert.equal(round.reviewStatus, "idle", round.error);
	assert.match(round.messages.at(-1)?.text ?? "", /blue/i);
	assert.match(round.messages.at(-1)?.text ?? "", /triangle/i);
	assert.ok(round.threadId);
	console.log("PASS: image input returned a blue triangle.");
	await review(
		store,
		game,
		round,
		"From the test image in my previous message, what color was the shape? Answer in one sentence.",
		() => {},
	);
	assert.equal(round.reviewStatus, "idle", round.error);
	assert.match(round.messages.at(-1)?.text ?? "", /blue/i);
	console.log("PASS: resumed conversation remembered the image.");
} finally {
	await rm(root, { recursive: true, force: true });
}
