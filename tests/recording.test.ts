import test from "node:test";
import assert from "node:assert/strict";
import {
	recordingStatus,
	type LiveRecordingTab,
} from "../src/shared/recording";

const now = 1_000_000;
const tab: LiveRecordingTab = {
	id: "profile:7",
	tabId: 7,
	browser: "Firefox",
	title: "Practice",
	url: "https://www.geoguessr.com/game/abc",
	enabled: true,
	visible: true,
	recognized: true,
	supported: true,
	activeRound: 1,
	gameId: "abc",
	completed: 0,
	seenAt: now,
	lastCapture: { gameId: "abc", round: 1, receivedAt: now },
};

test("recording requires a fresh receipt for this tab's current game and round", () => {
	assert.equal(recordingStatus(tab, now).recording, true);
	for (const patch of [
		{ enabled: false },
		{ visible: false },
		{ recognized: false },
		{ supported: false },
		{ activeRound: null },
		{ activeRound: 2 },
		{ gameId: "other" },
		{ lastCapture: undefined },
		{ error: "Click GeoCoach to resume screenshots." },
		{ seenAt: now - 16_000 },
		{ lastCapture: { gameId: "abc", round: 1, receivedAt: now - 21_000 } },
	])
		assert.equal(
			recordingStatus({ ...tab, ...patch }, now).recording,
			false,
			JSON.stringify(patch),
		);
	assert.match(
		recordingStatus({ ...tab, visible: false }, now).text,
		/background/,
	);
	assert.match(
		recordingStatus({ ...tab, seenAt: now - 16_000 }, now).text,
		/Connection lost/,
	);
});
