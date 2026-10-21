import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
	recordingStatus,
	STATUS_TIMEOUT,
	type LiveRecordingTab,
} from "../shared/recording";
import type { Game } from "../shared/schema";
import "./style.css";

const countryNames = new Intl.DisplayNames(["en"], { type: "region" });
const country = (code?: string) =>
	code ? (countryNames.of(code.toUpperCase()) ?? code) : "";
const coordinates = (point: { lat: number; lng: number }) =>
	`${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}`;
const reviewPrompts = [
	{
		label: "Get help",
		question:
			"What did I miss in this round? Show me the strongest useful clues and how to recognize them next time.",
	},
	{
		label: "I knew the country. How can I improve?",
		question:
			"I knew the country. How could I improve this guess? Focus on regional clues where the images support them.",
	},
	{
		label: "This was mostly luck. What did I miss?",
		question:
			"My guess was mostly luck. What clues should I have used to recognize the country?",
	},
];
const initialSelection = () => new URLSearchParams(location.hash.slice(1));

function App() {
	const [session, setSession] = useState<{ token: string }>();
	const [games, setGames] = useState<Game[]>([]);
	const [recordingTabs, setRecordingTabs] = useState<LiveRecordingTab[]>([]);
	const [connectionError, setConnectionError] = useState("");
	const [selectedGame, setSelectedGame] = useState(
		initialSelection().get("game") ?? "",
	);
	const [selectedRound, setSelectedRound] = useState(
		Number(initialSelection().get("round") ?? 1),
	);
	const [setup, setSetup] = useState(false);
	const [error, setError] = useState("");
	const [question, setQuestion] = useState("");
	const [sending, setSending] = useState(false);
	const [copied, setCopied] = useState(false);
	const [view, setView] = useState(() =>
		Math.max(0, Number(initialSelection().get("view") ?? 1) - 1),
	);
	const [showMeta, setShowMeta] = useState(false);
	const conversation = useRef<HTMLDivElement>(null);
	const game = games.find((g) => g.id === selectedGame) ?? games[0];
	const round =
		game?.rounds.find((r) => r.number === selectedRound) ?? game?.rounds[0];
	const running = round?.reviewStatus === "running";

	async function api(path: string, body?: object, method?: string) {
		const response = await fetch(path, {
			method: method ?? (body ? "POST" : "GET"),
			headers: {
				Authorization: `Bearer ${session?.token ?? ""}`,
				"Content-Type": "application/json",
			},
			body: body ? JSON.stringify(body) : undefined,
		});
		const data = await response.json();
		if (!response.ok) throw new Error(data.error ?? "Request failed.");
		return data;
	}

	useEffect(() => {
		fetch("/api/session")
			.then((response) => {
				if (!response.ok)
					throw new Error("Could not connect to the local app.");
				return response.json();
			})
			.then(setSession)
			.catch((error) => setError(error.message));
		const onHash = (event: HashChangeEvent) => {
			const previous = new URLSearchParams(new URL(event.oldURL).hash.slice(1));
			const next = initialSelection();
			setSelectedGame(next.get("game") ?? "");
			setSelectedRound(Number(next.get("round") ?? 1));
			setView(Math.max(0, Number(next.get("view") ?? 1) - 1));
			if (
				next.get("game") !== previous.get("game") ||
				next.get("round") !== previous.get("round")
			) {
				setQuestion("");
				setShowMeta(false);
			}
			if (next.has("view"))
				document
					.querySelector(".image-area")
					?.scrollIntoView({ block: "nearest", behavior: "smooth" });
		};
		addEventListener("hashchange", onHash);
		return () => removeEventListener("hashchange", onHash);
	}, []);

	useEffect(() => {
		if (!session) return;
		let live = true;
		const refresh = () =>
			Promise.all(
				["/api/games", "/api/recording"].map((path) =>
					fetch(path, {
						headers: { Authorization: `Bearer ${session.token}` },
						signal: AbortSignal.timeout(3000),
					}),
				),
			)
				.then(async (responses) => {
					if (responses.some((response) => !response.ok))
						throw new Error("Connection lost. Check the local server.");
					return Promise.all(responses.map((response) => response.json()));
				})
				.then(([data, tabs]) => {
					if (live) {
						setGames(data);
						setRecordingTabs(tabs);
						setConnectionError("");
					}
				})
				.catch((error) => {
					if (live) setConnectionError(error.message);
				});
		void refresh();
		const timer = setInterval(refresh, 2000);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, [session]);

	const messageCount = round?.messages.length ?? 0;
	useEffect(() => {
		if (messageCount)
			conversation.current?.scrollTo({
				top: conversation.current.scrollHeight,
			});
	}, [messageCount]);

	function select(gameId: string, number: number) {
		setSelectedGame(gameId);
		setSelectedRound(number);
		setView(0);
		setQuestion("");
		setShowMeta(false);
		history.replaceState(null, "", `#game=${gameId}&round=${number}`);
	}

	function selectView(index: number) {
		if (!game || !round) return;
		setView(index);
		history.replaceState(
			null,
			"",
			`#game=${game.id}&round=${round.number}&view=${index + 1}`,
		);
	}

	async function send(message = question) {
		if (!message.trim() || !game || !round?.result || running || sending)
			return;
		setSending(true);
		setError("");
		try {
			await api(`/api/games/${game.id}/rounds/${round.number}/chat`, {
				question: message,
			});
			if (message === question) setQuestion("");
			setGames(await api("/api/games"));
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setSending(false);
		}
	}

	async function deleteGame() {
		if (!game || !confirm("Delete this game, images, and chat?")) return;
		try {
			await api(`/api/games/${game.id}`, undefined, "DELETE");
			setGames(await api("/api/games"));
			setSelectedGame("");
			setView(0);
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		}
	}

	const currentView =
		Number.isInteger(view) && round
			? Math.min(Math.max(0, view), Math.max(0, round.captures.length - 1))
			: 0;
	const capture = round?.captures[currentView];

	return (
		<div className="app">
			<header>
				<strong>GeoCoach</strong>
				<select
					aria-label="Game"
					value={game?.id ?? ""}
					disabled={!games.length}
					onChange={(event) => select(event.target.value, 1)}
				>
					{!games.length && <option value="">No games</option>}
					{games.map((g) => (
						<option key={g.id} value={g.id}>
							{g.mapName} · {new Date(g.createdAt).toLocaleDateString()}
						</option>
					))}
				</select>
				<button
					type="button"
					className="setup-button"
					aria-expanded={setup}
					onClick={() => setSetup(!setup)}
				>
					Setup
				</button>
				{game && (
					<button
						type="button"
						onClick={() => {
							void deleteGame();
						}}
					>
						Delete game
					</button>
				)}
			</header>

			<section className="recording-status" aria-label="Recording status">
				<strong>Live recording</strong>
				{connectionError ? (
					<p role="alert">{connectionError} Recording cannot be confirmed.</p>
				) : (
					<>
						{!recordingTabs.length && (
							<p>
								No GeoGuessr tabs connected. Open GeoGuessr and click the
								GeoCoach extension. If it asks for a pairing code, open Setup.
								If the extension is already paired, refresh GeoGuessr.
							</p>
						)}
						{recordingTabs.map((tab) => {
							const status = recordingStatus(tab);
							return (
								<div
									key={tab.id}
									className={
										status.recording ? "tab-status confirmed" : "tab-status"
									}
								>
									<strong>{tab.title}</strong>{" "}
									<small>
										{tab.browser} · Tab {tab.tabId}
									</small>
									<div className="tab-url">{tab.url}</div>
									<p>{status.text}</p>
									{tab.lastCapture && (
										<small>
											Last screenshot received:{" "}
											{new Date(
												tab.lastCapture.receivedAt,
											).toLocaleTimeString()}
										</small>
									)}
								</div>
							);
						})}
					</>
				)}
			</section>

			{setup && (
				<section className="setup" aria-label="Setup">
					<p>
						{recordingTabs.some(
							(tab) => Date.now() - tab.seenAt < STATUS_TIMEOUT,
						)
							? "Extension connected. Already paired, no code needed."
							: "Pair once per browser. Closing tabs does not normally remove pairing."}{" "}
						Recording must be started on each new GeoGuessr tab. Check Live
						recording above before playing.
					</p>
					<p>
						Firefox: <code>about:debugging#/runtime/this-firefox</code> → Load
						Temporary Add-on → <code>dist/extension-firefox/manifest.json</code>
					</p>
					<p>
						<button
							type="button"
							disabled={!session}
							onClick={() => {
								if (session)
									void navigator.clipboard
										.writeText(session.token)
										.then(() => {
											setCopied(true);
											setTimeout(() => setCopied(false), 2000);
										})
										.catch(() => setError("Could not copy the pairing code."));
							}}
						>
							{copied ? "Copied" : "Copy pairing code"}
						</button>{" "}
						→ only if the extension asks for a code, paste it and click Connect
					</p>
					<p>
						Refresh GeoGuessr, then click the extension → Start recording this
						tab.
					</p>
					<details>
						<summary>Chrome</summary>
						<p>
							<code>chrome://extensions</code> → Developer mode → Load unpacked
							→ <code>dist/extension-chrome</code>
						</p>
					</details>
				</section>
			)}

			{error && (
				<div role="alert" className="error">
					{error}
					<button
						type="button"
						aria-label="Dismiss error"
						onClick={() => setError("")}
					>
						×
					</button>
				</div>
			)}

			{!game ? (
				<p className="empty">No rounds yet.</p>
			) : (
				<main>
					<nav className="rounds" aria-label="Rounds">
						{[1, 2, 3, 4, 5].map((number) => (
							<button
								type="button"
								key={number}
								disabled={!game.rounds.some((r) => r.number === number)}
								aria-current={round?.number === number ? "step" : undefined}
								onClick={() => select(game.id, number)}
							>
								Round {number}
							</button>
						))}
						{round?.result && (
							<span>
								{round.result.score?.toLocaleString() ?? "—"} pts
								{round.result.distanceMeters != null &&
									` · ${(round.result.distanceMeters / 1000).toLocaleString("en", { maximumFractionDigits: 1 })} km`}
							</span>
						)}
					</nav>

					{round && (
						<div className="review">
							<section className="evidence" aria-label="Round images">
								<div className="image-area">
									{capture ? (
										<img
											src={`/api/images/${capture.file}`}
											alt={`Round ${round.number}, view ${currentView + 1}`}
										/>
									) : (
										<span>No images.</span>
									)}
								</div>
								{round.captures.length > 0 && (
									<div className="image-controls">
										<button
											type="button"
											aria-label="Previous view"
											disabled={currentView === 0}
											onClick={() => selectView(currentView - 1)}
										>
											←
										</button>
										<span>
											{currentView + 1} / {round.captures.length}
										</span>
										<button
											type="button"
											aria-label="Next view"
											disabled={currentView >= round.captures.length - 1}
											onClick={() => selectView(currentView + 1)}
										>
											→
										</button>
										{capture && (
											<a
												href={`/api/images/${capture.file}`}
												target="_blank"
												rel="noreferrer"
											>
												Full size
											</a>
										)}
									</div>
								)}
								{round.captures.length > 1 && (
									<div className="thumbnails">
										{round.captures.map((image, index) => (
											<button
												type="button"
												key={image.id}
												aria-label={`View ${index + 1}`}
												aria-pressed={index === currentView}
												onClick={() => selectView(index)}
											>
												<img src={`/api/images/${image.file}`} alt="" />
											</button>
										))}
									</div>
								)}
								{round.result && (
									<div className="locations">
										<div>
											Score: {round.result.score?.toLocaleString() ?? "—"} pts
										</div>
										<div>
											Answer:{" "}
											<a
												href={`https://www.google.com/maps?q=${round.result.actual.lat},${round.result.actual.lng}`}
												target="_blank"
												rel="noreferrer"
											>
												{country(round.result.countryCode)}{" "}
												{coordinates(round.result.actual)}
											</a>
										</div>
										<div>
											Guess:{" "}
											{round.result.guess ? (
												<a
													href={`https://www.google.com/maps?q=${round.result.guess.lat},${round.result.guess.lng}`}
													target="_blank"
													rel="noreferrer"
												>
													{coordinates(round.result.guess)}
												</a>
											) : (
												"None"
											)}
										</div>
									</div>
								)}
								{round.meta && (
									<section className="meta">
										<button
											type="button"
											aria-expanded={showMeta}
											onClick={() => setShowMeta(!showMeta)}
										>
											Learnable Meta {showMeta ? "▴" : "▾"}
										</button>
										{showMeta && (
											<div>
												<strong>{round.meta.title}</strong>
												<p>{round.meta.text}</p>
												{round.meta.images.map((url) => (
													<img
														src={url}
														alt="Reference"
														key={url}
														loading="lazy"
														referrerPolicy="no-referrer"
													/>
												))}
												{round.meta.links.map((url) => (
													<a
														href={url}
														key={url}
														target="_blank"
														rel="noreferrer"
													>
														{new URL(url).hostname}
														{new URL(url).pathname}
													</a>
												))}
											</div>
										)}
									</section>
								)}
							</section>

							<section className="chat" aria-label="Round chat">
								<div className="messages" ref={conversation} aria-live="polite">
									{round.messages.map((message) => (
										<article key={message.id} className={message.role}>
											<small>{message.role === "user" ? "You" : "Codex"}</small>
											{message.role === "assistant" ? (
												<div
													className="prose"
													dangerouslySetInnerHTML={{
														__html: DOMPurify.sanitize(
															marked.parse(message.text, { async: false }),
															{ FORBID_TAGS: ["img"] },
														),
													}}
												/>
											) : (
												<p>{message.text}</p>
											)}
										</article>
									))}
									{running && <p className="muted">Thinking…</p>}
									{round.error && (
										<p role="alert" className="error">
											{round.error}
										</p>
									)}
								</div>
								<section
									className="review-prompts"
									aria-label="Quick review questions"
								>
									{reviewPrompts.map((prompt) => (
										<button
											key={prompt.label}
											type="button"
											disabled={!round.result || running || sending}
											onClick={() => {
												void send(prompt.question);
											}}
										>
											{prompt.label}
										</button>
									))}
								</section>
								<form
									onSubmit={(event) => {
										event.preventDefault();
										void send();
									}}
								>
									<textarea
										aria-label="Message"
										placeholder={
											round.result
												? "Ask about this round"
												: "Round in progress"
										}
										value={question}
										onChange={(event) => setQuestion(event.target.value)}
										disabled={!round.result || running || sending}
										rows={3}
										maxLength={12000}
										onKeyDown={(event) => {
											if (event.key === "Enter" && !event.shiftKey) {
												event.preventDefault();
												void send();
											}
										}}
									/>
									<button
										type="submit"
										disabled={
											!question.trim() || !round.result || running || sending
										}
									>
										Send
									</button>
								</form>
							</section>
						</div>
					)}
				</main>
			)}
		</div>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("App root missing.");
createRoot(root).render(<App />);
