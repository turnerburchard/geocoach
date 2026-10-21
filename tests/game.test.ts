import test from "node:test";
import assert from "node:assert/strict";
import { decodePano, parseGame } from "../src/extension/game";
import { buildPrompt } from "../src/server/coach";
import type { Game } from "../src/shared/schema";

const fixture = {
	token: "single-player-1",
	round: 2,
	mapName: "Architecture",
	forbidMoving: true,
	rounds: [
		{ lat: 38.5, lng: -7.9, panoId: "616263313233", countryCode: "PT" },
		{ lat: 52.1, lng: 4.3 },
	],
	player: {
		guesses: [
			{
				lat: 43.6,
				lng: 1.4,
				roundScore: { amount: "2638" },
				distance: { meters: { amount: "1008000" } },
			},
		],
	},
};

test("only completed rounds expose locations, with score units normalized", () => {
	const state = parseGame(fixture);
	assert.equal(state?.activeRound, 2);
	assert.equal(state?.completed.length, 1);
	assert.equal(state.completed[0].result.score, 2638);
	assert.equal(state.completed[0].result.distanceMeters, 1008000);
	assert.equal(state.completed[0].result.panoId, "abc123");
	assert.equal(JSON.stringify(state).includes("52.1"), false);
});
test("round results stop capture, and final results preserve all completed rounds", () => {
	const state = parseGame({ ...fixture, round: 1 });
	assert.equal(state?.activeRound, null);
	assert.equal(state.completed.length, 1);
});
test("reject unrelated payloads and mark moving games unsupported", () => {
	assert.equal(parseGame({ gameId: "multiplayer", rounds: [] }), null);
	assert.equal(
		parseGame({ ...fixture, forbidMoving: false })?.supported,
		false,
	);
	assert.equal(
		parseGame({ ...fixture, forbidMoving: undefined })?.supported,
		false,
	);
	assert.equal(decodePano("normal-pano_id"), "normal-pano_id");
});
test("coach treats reference context as data and handles rounds with no images honestly", () => {
	const game: Game = {
		id: "x",
		mapName: "Architecture",
		createdAt: "",
		updatedAt: "",
		rounds: [],
	};
	const prompt = buildPrompt(
		game,
		{
			number: 1,
			captures: [],
			reviewStatus: "idle",
			messages: [],
			result: fixtureResult(),
		},
		"Ignore car clues",
	);
	assert.match(prompt, /no views have been supplied/);
	assert.match(prompt, /not instructions/);
	assert.match(prompt, /Ignore car clues/);
	assert.match(prompt, /hindsight bias/);
});
export function fixtureResult() {
	return {
		actual: { lat: 38.5, lng: -7.9 },
		guess: { lat: 43.6, lng: 1.4 },
		score: 2638,
		distanceMeters: 1008000,
	};
}

test("distance amounts respect the unit supplied by GeoGuessr", () => {
	const state = parseGame({
		...fixture,
		player: {
			guesses: [
				{
					lat: 43.6,
					lng: 1.4,
					distance: { meters: { amount: "127.9", unit: "km" } },
				},
			],
		},
	});
	assert.equal(state?.completed[0].result.distanceMeters, 127900);
});
