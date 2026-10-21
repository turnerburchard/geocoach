import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { selectViews } from "../src/server/views";
import { review } from "../src/server/coach";
import { Store } from "../src/server/store";
import type { Capture } from "../src/shared/schema";

const colors = [
	"#ee2222",
	"#22ee22",
	"#2222ee",
	"#eeee22",
	"#ee22ee",
	"#22eeee",
	"#222222",
	"#eeeeee",
	"#992222",
	"#229922",
	"#222299",
	"#999922",
	"#992299",
	"#229999",
];
async function images(root: string): Promise<Capture[]> {
	await mkdir(join(root, "images"), { recursive: true });
	return Promise.all(
		colors.map(async (background, index) => {
			const file = `${index + 1}.jpg`;
			await sharp({
				create: { width: 160, height: 120, channels: 3, background },
			})
				.jpeg()
				.toFile(join(root, "images", file));
			return {
				id: String(index + 1),
				file,
				reason: "view",
				capturedAt: new Date(index * 1000).toISOString(),
			};
		}),
	);
}

test("initial selection caps distinct scenes at six and skips near-duplicate captures", async () => {
	const root = await mkdtemp(join(tmpdir(), "geocoach-views-"));
	try {
		const captures = await images(root);
		await sharp(join(root, "images", captures[0].file))
			.jpeg({ quality: 60 })
			.toFile(join(root, "images", "duplicate.jpg"));
		const duplicate: Capture = {
			...captures[0],
			id: "duplicate",
			file: "duplicate.jpg",
		};
		const all = [captures[0], duplicate, ...captures.slice(1)];
		const selected = await selectViews(root, all);
		assert.equal(selected.length, 6);
		assert.equal(
			selected.some((c) => c.id === "duplicate"),
			false,
		);
		assert.deepEqual(
			selected.map((c) => all.indexOf(c)),
			selected.map((c) => all.indexOf(c)).sort((a, b) => a - b),
		);
		assert.equal((await selectViews(root, [captures[0], duplicate])).length, 1);
		assert.deepEqual(await selectViews(root, []), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("coach requests one extra batch, preserves gallery numbering, and remembers its budget across restarts", async () => {
	const root = await mkdtemp(join(tmpdir(), "geocoach-batches-"));
	const oldExecutable = process.env.GEOCOACH_CODEX;
	try {
		const store = new Store(root);
		const round = store.upsert({
			gameId: "batch-test",
			round: 1,
			mapName: "Practice",
			result: {
				actual: { lat: 0, lng: 0 },
				guess: null,
				score: 0,
				distanceMeters: null,
			},
		});
		round.captures = await images(root);
		const executable = join(root, "fake-codex");
		await writeFile(
			executable,
			`#!/usr/bin/env node
const fs = require('node:fs');
let prompt = '';
process.stdin.on('data', data => prompt += data);
process.stdin.on('end', () => {
  fs.appendFileSync('calls.jsonl', JSON.stringify({args:process.argv.slice(2),prompt})+'\\n');
  const available = JSON.parse(prompt.match(/Unseen views available: (.*)/)[1]);
  const seen = JSON.parse(prompt.match(/Views supplied to this conversation: (.*)/)[1]);
  const ask = !process.argv.includes('resume') || prompt.includes('request-again');
  const response = ask ? {answer:'',moreViews:available.slice(0,6)} : {answer:'Look at [View '+seen.at(-1)+'](#game=batch-test&round=1&view='+seen.at(-1)+').',moreViews:[]};
  console.log(JSON.stringify({type:'thread.started',thread_id:'batch-thread'}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(response)}}));
  console.log(JSON.stringify({type:'turn.completed'}));
});
`,
			{ mode: 0o700 },
		);
		process.env.GEOCOACH_CODEX = executable;
		const game = store.game("batch-test");
		if (!game) throw new Error("Missing game");
		await review(store, game, round, "What did I miss?", () => {});
		assert.equal(round.reviewStatus, "idle", round.error);
		assert.equal(round.coachImages?.ids.length, 12);
		assert.equal(round.coachImages?.expanded, true);
		assert.equal(round.messages.length, 2);
		assert.match(
			round.messages[1].text,
			/\[View \d+\]\(#game=batch-test&round=1&view=\d+\)/,
		);
		const calls = (await readFile(join(root, "coach", "calls.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.equal(calls.length, 2);
		assert.equal(calls[0].args.filter((arg: string) => arg === "-i").length, 6);
		assert.equal(calls[1].args.filter((arg: string) => arg === "-i").length, 6);
		assert.equal(calls[1].args.includes("batch-thread"), true);
		const attached = calls.flatMap((call) =>
			call.args.filter(
				(_: string, index: number) => call.args[index - 1] === "-i",
			),
		);
		assert.equal(new Set(attached).size, 12);
		const reloaded = new Store(root);
		const savedGame = reloaded.game("batch-test"),
			savedRound = reloaded.round("batch-test", 1);
		if (!savedGame || !savedRound) throw new Error("Missing saved round");
		await review(
			reloaded,
			savedGame,
			savedRound,
			"One more question",
			() => {},
		);
		assert.equal(savedRound.reviewStatus, "idle", savedRound.error);
		let log = (await readFile(join(root, "coach", "calls.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.equal(log[2].args.includes("-i"), false);
		assert.match(log[2].prompt, /No more images can be requested/);
		await review(reloaded, savedGame, savedRound, "request-again", () => {});
		assert.equal(savedRound.reviewStatus, "error");
		assert.match(savedRound.error ?? "", /already been used/);
		log = (await readFile(join(root, "coach", "calls.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.equal(log.length, 4);
	} finally {
		if (oldExecutable) process.env.GEOCOACH_CODEX = oldExecutable;
		else delete process.env.GEOCOACH_CODEX;
		await rm(root, { recursive: true, force: true });
	}
});
