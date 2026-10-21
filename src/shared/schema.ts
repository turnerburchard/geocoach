import { z } from "zod";

export const APP_URL = "http://127.0.0.1:43821";
export const gameIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const locationSchema = z.object({
	lat: z.number().min(-90).max(90),
	lng: z.number().min(-180).max(180),
});
const safeUrl = z
	.url()
	.max(2000)
	.refine((s) => /^https:\/\//.test(s));
export const metaSchema = z.object({
	title: z.string().max(500),
	text: z.string().max(20000),
	links: z.array(safeUrl).max(30),
	images: z.array(safeUrl).max(15),
	source: z.enum(["cache", "displayed-card"]),
});
export const resultSchema = z.object({
	actual: locationSchema,
	guess: locationSchema.nullable(),
	score: z.number().min(0).max(5000).nullable(),
	distanceMeters: z.number().min(0).nullable(),
	countryCode: z.string().max(5).optional(),
	panoId: z.string().max(300).optional(),
});
export const roundUpdateSchema = z.object({
	gameId: gameIdSchema,
	mapName: z.string().max(300),
	round: z.number().int().min(1).max(5),
	result: resultSchema.optional(),
	meta: metaSchema.optional(),
});
export const captureSchema = z.object({
	gameId: gameIdSchema,
	mapName: z.string().max(300),
	round: z.number().int().min(1).max(5),
	image: z
		.string()
		.max(20_000_000)
		.regex(/^data:image\/(jpeg|png);base64,[a-zA-Z0-9+/=]+$/),
	captureId: z.uuid(),
	capturedAt: z.iso.datetime(),
	reason: z.enum(["start", "view", "periodic"]),
	rect: z
		.object({
			x: z.number().min(0),
			y: z.number().min(0),
			width: z.number().positive(),
			height: z.number().positive(),
			viewportWidth: z.number().positive(),
			viewportHeight: z.number().positive(),
		})
		.optional(),
});
export type RoundUpdate = z.infer<typeof roundUpdateSchema>;
export type CaptureInput = z.infer<typeof captureSchema>;
export type Meta = z.infer<typeof metaSchema>;
export type RoundResult = z.infer<typeof resultSchema>;
export type Capture = {
	id: string;
	capturedAt: string;
	reason: CaptureInput["reason"];
	file: string;
};
export type Message = {
	id: string;
	role: "user" | "assistant";
	text: string;
	createdAt: string;
};
export type Round = {
	number: number;
	captures: Capture[];
	result?: RoundResult;
	meta?: Meta;
	messages: Message[];
	threadId?: string;
	coachImages?: { ids: string[]; expanded: boolean };
	reviewStatus: "idle" | "running" | "error";
	error?: string;
};
export type Game = {
	id: string;
	mapName: string;
	createdAt: string;
	updatedAt: string;
	rounds: Round[];
};
export type PageState = {
	gameId: string;
	mapName: string;
	activeRound: number | null;
	completed: { round: number; result: RoundResult }[];
	supported: boolean;
};
export type PageEvent =
	| { source: "geocoach-page"; type: "state"; state: PageState; path: string }
	| {
			source: "geocoach-page";
			type: "meta";
			gameId: string;
			round: number;
			meta: Meta;
	  };
