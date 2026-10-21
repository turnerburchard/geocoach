import {
	mkdirSync,
	existsSync,
	readFileSync,
	writeFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Game, Round, RoundUpdate } from "../shared/schema";

export class Store {
	readonly root: string;
	readonly token: string;
	private games: Game[];
	constructor(root: string) {
		this.root = root;
		mkdirSync(join(root, "images"), { recursive: true, mode: 0o700 });
		mkdirSync(join(root, "coach"), { recursive: true, mode: 0o700 });
		const tokenPath = join(root, "token");
		if (!existsSync(tokenPath))
			writeFileSync(tokenPath, randomBytes(32).toString("hex"), {
				mode: 0o600,
			});
		this.token = readFileSync(tokenPath, "utf8");
		this.games = existsSync(join(root, "games.json"))
			? JSON.parse(readFileSync(join(root, "games.json"), "utf8"))
			: [];
		for (const game of this.games)
			for (const round of game.rounds) {
				if (round.reviewStatus === "running") {
					round.reviewStatus = "error";
					round.error =
						"The local server stopped during this reply. Send your question again to continue.";
				}
			}
		this.save();
	}
	list() {
		return [...this.games].sort((a, b) =>
			b.updatedAt.localeCompare(a.updatedAt),
		);
	}
	game(id: string) {
		return this.games.find((game) => game.id === id);
	}
	round(gameId: string, number: number) {
		return this.game(gameId)?.rounds.find((r) => r.number === number);
	}
	upsert(input: RoundUpdate): Round {
		let game = this.game(input.gameId);
		if (!game) {
			game = {
				id: input.gameId,
				mapName: input.mapName,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				rounds: [],
			};
			this.games.push(game);
		}
		game.mapName = input.mapName || game.mapName;
		game.updatedAt = new Date().toISOString();
		let round = this.round(input.gameId, input.round);
		if (!round) {
			round = {
				number: input.round,
				captures: [],
				messages: [],
				reviewStatus: "idle",
			};
			game.rounds.push(round);
			game.rounds.sort((a, b) => a.number - b.number);
		}
		if (input.result) round.result = input.result;
		if (input.meta) round.meta = input.meta;
		this.save();
		return round;
	}
	save() {
		const path = join(this.root, "games.json");
		writeFileSync(`${path}.tmp`, JSON.stringify(this.games), { mode: 0o600 });
		renameSync(`${path}.tmp`, path);
	}
	delete(id: string) {
		const game = this.game(id);
		if (!game) return;
		for (const round of game.rounds) {
			for (const image of [
				...round.captures,
				...(round.coachImages?.crops ?? []),
			])
				rmSync(join(this.root, "images", image.file), { force: true });
		}
		this.games = this.games.filter((g) => g.id !== id);
		this.save();
	}
}
