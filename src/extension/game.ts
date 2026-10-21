import { z } from "zod";
import type { PageState, RoundResult } from "../shared/schema";
import { locationSchema } from "../shared/schema";

const amount = z
	.union([z.number(), z.string()])
	.transform(Number)
	.pipe(z.number().finite());
const upstreamGame = z.object({
	token: z.string(),
	round: z.number().int().min(1).max(5),
	mapName: z.string().optional(),
	forbidMoving: z.boolean().optional(),
	rounds: z.array(
		locationSchema.extend({
			panoId: z.string().nullish(),
			countryCode: z.string().nullish(),
		}),
	),
	player: z.object({
		guesses: z.array(
			z.object({
				lat: z.number().optional(),
				lng: z.number().optional(),
				roundScore: z.object({ amount }).optional(),
				distance: z
					.object({
						meters: z.object({ amount, unit: z.enum(["m", "km"]).optional() }),
					})
					.optional(),
			}),
		),
	}),
});

export function decodePano(id?: string | null) {
	if (!id) return undefined;
	if (/^(?:[a-f0-9]{2})+$/i.test(id)) {
		const decoded = id.replace(/../g, (hex) =>
			String.fromCharCode(Number.parseInt(hex, 16)),
		);
		if (/^[\w-]+$/.test(decoded)) return decoded;
	}
	return id;
}

export function parseGame(data: unknown): PageState | null {
	const parsed = upstreamGame.safeParse(data);
	if (!parsed.success) return null;
	const game = parsed.data;
	const completed: PageState["completed"] = [];
	for (
		let index = 0;
		index < Math.min(game.player.guesses.length, game.rounds.length, 5);
		index++
	) {
		const actual = game.rounds[index];
		const guess = game.player.guesses[index];
		const result: RoundResult = {
			actual: { lat: actual.lat, lng: actual.lng },
			guess:
				typeof guess.lat === "number" && typeof guess.lng === "number"
					? { lat: guess.lat, lng: guess.lng }
					: null,
			score: guess.roundScore?.amount ?? null,
			distanceMeters: guess.distance
				? guess.distance.meters.amount *
					(guess.distance.meters.unit === "km" ? 1000 : 1)
				: null,
			countryCode: actual.countryCode ?? undefined,
			panoId: decodePano(actual.panoId),
		};
		completed.push({ round: index + 1, result });
	}
	return {
		gameId: game.token,
		mapName: game.mapName ?? "Single-player practice",
		activeRound: game.player.guesses.length < game.round ? game.round : null,
		completed,
		supported: game.forbidMoving === true,
	};
}
