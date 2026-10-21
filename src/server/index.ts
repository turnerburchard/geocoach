import express from "express";
import { createServer } from "node:http";
import { resolve, join } from "node:path";
import { writeFileSync, rmSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import {
	APP_URL,
	captureSchema,
	roundUpdateSchema,
	gameIdSchema,
} from "../shared/schema";
import { recordingTabSchema, type LiveRecordingTab } from "../shared/recording";
import { Store } from "./store";
import { review } from "./coach";

export function createApp(root: string) {
	const store = new Store(resolve(root));
	const app = express();
	const recordingTabs = new Map<string, LiveRecordingTab>();
	app.disable("x-powered-by");
	app.use((req, res, next) => {
		if (
			!["127.0.0.1:43821", "localhost:43821"].includes(req.headers.host ?? "")
		)
			return res.status(403).json({ error: "Invalid local host." });
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader("Cache-Control", "no-store");
		res.setHeader(
			"Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
		);
		const origin = req.headers.origin;
		if (origin && origin !== APP_URL && origin !== "http://localhost:43821") {
			if (!/^(chrome-extension|moz-extension):\/\/[a-zA-Z0-9-]+$/.test(origin))
				return res.status(403).json({ error: "Origin not allowed." });
			res.setHeader("Access-Control-Allow-Origin", origin);
			res.setHeader("Vary", "Origin");
			res.setHeader(
				"Access-Control-Allow-Headers",
				"Authorization, Content-Type",
			);
			res.setHeader(
				"Access-Control-Allow-Methods",
				"GET, POST, DELETE, OPTIONS",
			);
		}
		if (req.method === "OPTIONS") return res.sendStatus(204);
		next();
	});
	app.get("/api/health", (_req, res) =>
		res.json({ ok: true, version: "0.1.0" }),
	);
	app.get("/api/session", (req, res) => {
		const origin = req.headers.origin;
		if (
			(origin && origin !== APP_URL && origin !== "http://localhost:43821") ||
			req.headers["sec-fetch-site"] === "cross-site"
		)
			return res
				.status(403)
				.json({ error: "Open the local review page to pair." });
		res.cookie("geocoach_images", store.token, {
			httpOnly: true,
			sameSite: "strict",
			path: "/api/images",
		});
		res.json({ token: store.token, dataPath: store.root });
	});
	app.use("/api", (req, res, next) => {
		const imageCookie =
			req.path.startsWith("/images/") && req.method === "GET"
				? req.headers.cookie
						?.split(";")
						.map((c) => c.trim())
						.find((c) => c.startsWith("geocoach_images="))
						?.slice("geocoach_images=".length)
				: undefined;
		const bearer = Buffer.from(
			req.headers.authorization?.replace(/^Bearer /, "") || imageCookie || "",
		);
		const token = Buffer.from(store.token);
		if (bearer.length !== token.length || !timingSafeEqual(bearer, token))
			return res.status(401).json({
				error: "Pair the extension with your local review app first.",
			});
		next();
	});
	app.use(express.json({ limit: "22mb" }));
	app.post("/api/recording", (req, res) => {
		const tab = recordingTabSchema.parse(req.body);
		recordingTabs.set(tab.id, { ...tab, seenAt: Date.now() });
		res.json({ ok: true });
	});
	app.get("/api/recording", (_req, res) => {
		for (const [id, tab] of recordingTabs) {
			if (Date.now() - tab.seenAt > 60_000) recordingTabs.delete(id);
		}
		res.json([...recordingTabs.values()]);
	});
	app.delete("/api/recording/:id", (req, res) => {
		recordingTabs.delete(req.params.id);
		res.json({ ok: true });
	});
	app.get("/api/games", (_req, res) => res.json(store.list()));
	app.post("/api/rounds", (req, res) => {
		const input = roundUpdateSchema.parse(req.body);
		store.upsert(input);
		res.json({ ok: true });
	});
	app.post("/api/captures", async (req, res) => {
		const input = captureSchema.parse(req.body);
		const round = store.upsert(input);
		if (round.result) return res.json({ ok: true, stored: false });
		if (round.captures.some((c) => c.id === input.captureId))
			return res.json({ ok: true, stored: true });
		const bytes = Buffer.from(input.image.split(",")[1], "base64");
		const pipeline = sharp(bytes, { limitInputPixels: 40_000_000 });
		const info = await pipeline.metadata();
		if (
			!info.width ||
			!info.height ||
			!["jpeg", "png"].includes(info.format ?? "")
		)
			return res.status(400).json({ error: "Unsupported capture." });
		if (input.rect) {
			const { rect } = input;
			const sx = info.width / rect.viewportWidth;
			const sy = info.height / rect.viewportHeight;
			const left = Math.min(info.width - 1, Math.round(rect.x * sx));
			const top = Math.min(info.height - 1, Math.round(rect.y * sy));
			pipeline.extract({
				left,
				top,
				width: Math.max(
					1,
					Math.min(info.width - left, Math.round(rect.width * sx)),
				),
				height: Math.max(
					1,
					Math.min(info.height - top, Math.round(rect.height * sy)),
				),
			});
		}
		const image = await pipeline
			.resize({ width: 1920, withoutEnlargement: true })
			.jpeg({ quality: 85 })
			.toBuffer();
		const hash = createHash("sha256").update(image).digest("hex");
		if (round.result) return res.json({ ok: true, stored: false });
		if (round.captures.some((c) => c.file.endsWith(`${hash}.jpg`)))
			return res.json({ ok: true, stored: true });
		const file = `${input.captureId}-${hash}.jpg`;
		writeFileSync(join(store.root, "images", file), image, { mode: 0o600 });
		round.captures.push({
			id: input.captureId,
			file,
			capturedAt: input.capturedAt,
			reason: input.reason,
		});
		if (round.captures.length > 32) {
			const [removed] = round.captures.splice(1, 1);
			rmSync(join(store.root, "images", removed.file), { force: true });
		}
		store.save();
		res.json({ ok: true, stored: true });
	});
	app.get("/api/images/:file", (req, res) => {
		const file = z
			.string()
			.regex(/^[a-f0-9-]+-[a-f0-9]{64}\.jpg$/)
			.parse(req.params.file);
		res.sendFile(file, { root: join(store.root, "images") });
	});
	app.post("/api/games/:id/rounds/:number/chat", (req, res) => {
		const id = gameIdSchema.parse(req.params.id);
		const number = z.coerce
			.number()
			.int()
			.min(1)
			.max(5)
			.parse(req.params.number);
		const { question } = z
			.object({ question: z.string().trim().min(1).max(12000) })
			.parse(req.body);
		const game = store.game(id);
		const round = store.round(id, number);
		if (!game || !round)
			return res.status(404).json({ error: "Round not found." });
		if (!round.result)
			return res
				.status(409)
				.json({ error: "Finish this round before requesting a review." });
		if (round.reviewStatus === "running")
			return res
				.status(409)
				.json({ error: "A reply is already running for this round." });
		void review(store, game, round, question, () => {});
		res.status(202).json({ ok: true });
	});
	app.delete("/api/games/:id", (req, res) => {
		const id = gameIdSchema.parse(req.params.id);
		if (store.game(id)?.rounds.some((r) => r.reviewStatus === "running"))
			return res.status(409).json({
				error: "Wait for the current reply before deleting this game.",
			});
		store.delete(id);
		res.json({ ok: true });
	});
	const web = resolve("dist/web");
	app.use(express.static(web));
	app.use(
		(
			error: unknown,
			_req: express.Request,
			res: express.Response,
			_next: express.NextFunction,
		) => {
			if (error instanceof z.ZodError)
				return res.status(400).json({
					error: "Invalid request.",
					details: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
				});
			console.error(error);
			res.status(500).json({
				error:
					"The local app could not complete this request. Check the terminal.",
			});
		},
	);
	return { app, store };
}

if (process.env.GEOCOACH_TEST !== "1") {
	const server = createServer();
	server.on("error", (error) => {
		console.error(`GeoCoach could not start: ${error.message}`);
		process.exitCode = 1;
	});
	server.listen(43821, "127.0.0.1", () => {
		const { app } = createApp(process.env.GEOCOACH_DATA ?? ".data");
		server.on("request", app);
		console.log(
			`GeoCoach is ready at ${APP_URL}\nOpen the page to pair your extension. Press Ctrl+C to stop.`,
		);
	});
}
