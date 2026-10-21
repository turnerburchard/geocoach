import test from "node:test";
import assert from "node:assert/strict";
import {
	mkdtemp,
	mkdir,
	writeFile,
	rm,
	readFile,
	readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { selectViews, cropView } from "../src/server/views";
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

test("zoom crops the requested source pixels and rejects regions outside the image", async () => {
	const root = await mkdtemp(join(tmpdir(), "geocoach-crop-"));
	try {
		await mkdir(join(root, "images"));
		const source = await sharp(
			Buffer.from(
				'<svg width="200" height="120"><rect width="100" height="120" fill="red"/><rect x="100" width="100" height="120" fill="blue"/></svg>',
			),
		)
			.png()
			.toBuffer();
		await writeFile(join(root, "images", "source.png"), source);
		const capture: Capture = {
			id: "source",
			file: "source.png",
			capturedAt: "",
			reason: "view",
		};
		const crop = await cropView(root, capture, {
			x: 0.5,
			y: 0,
			width: 0.5,
			height: 1,
		});
		const image = sharp(join(root, "images", crop.file));
		const metadata = await image.metadata();
		assert.equal(metadata.width, 100);
		assert.equal(metadata.height, 120);
		assert.deepEqual(
			[...(await image.removeAlpha().raw().toBuffer()).subarray(0, 3)],
			[0, 0, 255],
		);
		assert.deepEqual(
			await readFile(join(root, "images", "source.png")),
			source,
		);
		await assert.rejects(
			cropView(root, capture, { x: 0.8, y: 0, width: 0.5, height: 1 }),
			/outside/,
		);
		assert.equal((await readdir(join(root, "images"))).length, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("coach inspects views and crops, resets the budget on follow-up, and preserves old conversations", async () => {
	const root = await mkdtemp(join(tmpdir(), "geocoach-inspection-"));
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
  const args = process.argv.slice(2);
  const schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1], 'utf8'));
  fs.appendFileSync('calls.jsonl', JSON.stringify({args,prompt,schema})+'\\n');
  const available = JSON.parse(prompt.match(/Unseen views available: (.*)/)[1]);
  const seen = JSON.parse(prompt.match(/Views supplied to this conversation: (.*)/)[1]);
  const remaining = Number(prompt.match(/Inspection passes remaining for this question: (.*)/)[1]);
  const region = {x:0,y:0,width:0.5,height:0.5};
  let inspect = [];
  if (prompt.includes('unseen-zoom')) inspect = [{kind:'zoom',view:available[0],region}];
  else if (prompt.includes('ignore-limit')) inspect = [{kind:'zoom',view:seen[0],region:{...region,x:remaining*0.1}}];
  else if (remaining === 2 && available.length) inspect = available.slice(0,prompt.includes('Follow-up inspection')?1:6).map(view=>({kind:'view',view}));
  else if (remaining === 1) inspect = [{kind:'zoom',view:seen[0],region}];
  const response = {answer:inspect.length?'':'The crop of [View '+seen[0]+'](#game=batch-test&round=1&view='+seen[0]+') shows the clue.',inspect};
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
		assert.equal(round.coachImages?.crops?.length, 1);
		assert.equal(round.captures.length, 14);
		assert.equal(round.messages.length, 2);
		assert.match(
			round.messages[1].text,
			/\[View \d+\]\(#game=batch-test&round=1&view=\d+\)/,
		);
		const calls = async () =>
			(await readFile(join(root, "coach", "calls.jsonl"), "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
		let log = await calls();
		assert.equal(log.length, 3);
		assert.deepEqual(
			log.map((c) => c.args.filter((a: string) => a === "-i").length),
			[6, 6, 1],
		);
		assert.match(log[2].prompt, /Crop of original view/);
		assert.equal(log[2].schema.properties.inspect.maxItems, 0);
		assert.equal(
			new Set(log.map((c) => c.args[c.args.indexOf("--output-schema") + 1]))
				.size,
			3,
		);
		assert.deepEqual(await readdir(join(root, "coach")), ["calls.jsonl"]);

		Object.assign(round.coachImages ?? {}, { expanded: true });
		store.save();
		const reloaded = new Store(root);
		const savedGame = reloaded.game("batch-test"),
			savedRound = reloaded.round("batch-test", 1);
		if (!savedGame || !savedRound) throw new Error("Missing saved round");
		await review(
			reloaded,
			savedGame,
			savedRound,
			"Follow-up inspection",
			() => {},
		);
		assert.equal(savedRound.reviewStatus, "idle", savedRound.error);
		assert.equal(savedRound.coachImages?.ids.length, 13);
		assert.equal(savedRound.coachImages?.crops?.length, 1);
		log = await calls();
		assert.equal(log.length, 6);
		assert.match(
			log[3].prompt,
			/Inspection passes remaining for this question: 2/,
		);
		assert.equal(log[3].args.includes("batch-thread"), true);
		assert.equal(log[3].args.filter((a: string) => a === "-i").length, 0);

		await review(reloaded, savedGame, savedRound, "unseen-zoom", () => {});
		assert.equal(savedRound.reviewStatus, "error");
		assert.match(savedRound.error ?? "", /full view before/);
		assert.equal((await calls()).length, 7);

		await review(reloaded, savedGame, savedRound, "ignore-limit", () => {});
		assert.equal(savedRound.reviewStatus, "error");
		assert.match(savedRound.error ?? "", /too_big/);
		assert.equal((await calls()).length, 10);
		reloaded.delete("batch-test");
		assert.deepEqual(await readdir(join(root, "images")), []);
	} finally {
		if (oldExecutable) process.env.GEOCOACH_CODEX = oldExecutable;
		else delete process.env.GEOCOACH_CODEX;
		await rm(root, { recursive: true, force: true });
	}
});
