import { z } from "zod";

export const STATUS_TIMEOUT = 15_000;
export const CAPTURE_TIMEOUT = 20_000;
export const pageStatusSchema = z.object({
	recognized: z.boolean(),
	supported: z.boolean(),
	visible: z.boolean(),
	gameId: z.string().optional(),
	activeRound: z.number().int().min(1).max(5).nullable(),
	completed: z.number().int().min(0).max(5),
});
export const recordingTabSchema = pageStatusSchema.extend({
	id: z.string().max(100),
	tabId: z.number().int(),
	browser: z.enum(["Firefox", "Chrome"]),
	title: z.string().max(500),
	url: z
		.string()
		.max(2000)
		.regex(/^https:\/\/(www\.)?geoguessr\.com\//),
	enabled: z.boolean(),
	error: z.string().max(2000).optional(),
	lastCapture: z
		.object({
			gameId: z.string(),
			round: z.number().int(),
			receivedAt: z.number(),
		})
		.optional(),
});
export type RecordingTab = z.infer<typeof recordingTabSchema>;
export type LiveRecordingTab = RecordingTab & { seenAt: number };

export function recordingStatus(
	tab: RecordingTab & { seenAt?: number },
	now = Date.now(),
) {
	if (tab.seenAt !== undefined && now - tab.seenAt > STATUS_TIMEOUT)
		return {
			recording: false,
			text: "Connection lost. Open this tab and check the extension.",
		};
	if (!tab.enabled)
		return {
			recording: false,
			text: "Recording off. Click GeoCoach on this tab, then Start recording this tab.",
		};
	if (tab.error) return { recording: false, text: tab.error };
	if (!tab.visible)
		return { recording: false, text: "Paused: tab is in the background." };
	if (!tab.recognized)
		return {
			recording: false,
			text: "Waiting for a game. Start a no-move or NMPZ game. Refresh GeoGuessr if needed.",
		};
	if (!tab.supported)
		return {
			recording: false,
			text: "This game isn't supported. Use single-player no move or NMPZ.",
		};
	if (!tab.activeRound)
		return {
			recording: false,
			text: `${tab.completed} completed rounds. Waiting for the next round.`,
		};
	const capture = tab.lastCapture;
	if (
		!capture ||
		capture.gameId !== tab.gameId ||
		capture.round !== tab.activeRound
	)
		return {
			recording: false,
			text: `Round ${tab.activeRound}: waiting for the first screenshot. Keep this tab open.`,
		};
	if (now - capture.receivedAt > CAPTURE_TIMEOUT)
		return {
			recording: false,
			text: "Screenshots stopped arriving. Keep this tab active and check the extension.",
		};
	return {
		recording: true,
		text: `Recording round ${tab.activeRound}. Screenshot received.`,
	};
}
