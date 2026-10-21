import { APP_URL } from "../shared/schema";
import { ext } from "./browser";
import type {
	PageEvent,
	PageState,
	CaptureInput,
	Meta,
} from "../shared/schema";

let state: PageState | null = null;
let statePath = "";
let recording = false;
let viewTimer: ReturnType<typeof setTimeout> | undefined;
let lastCaptured = 0;
let startKey = "";
let cardRound: number | undefined;
const updates = new Map<string, string>();
const pendingMeta = new Map<string, Meta>();

const send = (message: unknown) => ext.runtime.sendMessage(message);
const update = async (input: object, key: string) => {
	const signature = JSON.stringify(input);
	if (updates.get(key) === signature) return;
	const response = await send({ type: "round", input });
	if (response?.ok) updates.set(key, signature);
};

function panoramaRect() {
	const element = document.querySelector<HTMLElement>(
		'[aria-label="Street View"]',
	);
	if (!element) return undefined;
	const rect = element.getBoundingClientRect();
	const x = Math.max(0, rect.left),
		y = Math.max(0, rect.top);
	const width = Math.min(innerWidth, rect.right) - x,
		height = Math.min(innerHeight, rect.bottom) - y;
	if (width < 200 || height < 200) return undefined;
	return {
		x,
		y,
		width,
		height,
		viewportWidth: innerWidth,
		viewportHeight: innerHeight,
	};
}

function canCapture() {
	return (
		recording &&
		statePath === location.pathname &&
		state?.supported &&
		state.activeRound &&
		document.visibilityState === "visible" &&
		/^\/(game|challenge)\//.test(location.pathname) &&
		!document.querySelector('[data-qa="result-view-top"]')
	);
}

async function capture(reason: CaptureInput["reason"]) {
	if (!canCapture() || !state?.activeRound) return;
	const roundKey = `${state.gameId}:${state.activeRound}`;
	const rect = panoramaRect();
	if (!rect) return;
	lastCaptured = Date.now();
	const response = await send({
		type: "capture",
		input: {
			gameId: state.gameId,
			mapName: state.mapName,
			round: state.activeRound,
			capturedAt: new Date().toISOString(),
			captureId: crypto.randomUUID(),
			reason,
			rect,
		},
	});
	if (response?.ok) startKey = roundKey;
}

function scheduleCapture() {
	clearTimeout(viewTimer);
	viewTimer = setTimeout(() => {
		void capture("view");
	}, 700);
}

function readCard() {
	if (
		!state ||
		!recording ||
		statePath !== location.pathname ||
		state.activeRound ||
		!state.completed.length
	)
		return;
	const container = document.querySelector<HTMLElement>(".geometa-container");
	if (!container) return;
	const title = container
		.querySelector("strong")
		?.parentElement?.textContent?.trim();
	const note = container.querySelector<HTMLElement>(".geometa-note");
	if (!title || !note?.textContent?.trim()) return;
	const displayedRound =
		cardRound ??
		(state.completed.length < 5 ? state.completed.at(-1)?.round : undefined);
	const completed = state.completed.find((r) => r.round === displayedRound);
	if (!completed) return;
	const meta: Meta = {
		title,
		text: note.innerText,
		links: [
			...container.querySelectorAll<HTMLAnchorElement>(
				".geometa-note a, .geometa-footer a",
			),
		]
			.map((a) => a.href)
			.filter((s) => s.startsWith("https://")),
		images: [...container.querySelectorAll<HTMLImageElement>("img")]
			.map((i) => i.src)
			.filter((s) => s.startsWith("https://")),
		source: "displayed-card",
	};
	const key = `${state.gameId}:${completed.round}`;
	if (pendingMeta.get(key)?.source !== "cache") pendingMeta.set(key, meta);
}

function pageStatus() {
	const recognized = Boolean(state && statePath === location.pathname);
	return {
		recognized,
		supported: recognized && state?.supported === true,
		visible: document.visibilityState === "visible",
		gameId: recognized ? state?.gameId : undefined,
		activeRound: recognized ? (state?.activeRound ?? null) : null,
		completed: recognized ? (state?.completed.length ?? 0) : 0,
	};
}

function showRecordingStatus(text: string, confirmed: boolean) {
	let banner = document.getElementById("geocoach-status");
	if (!banner) {
		banner = document.createElement("div");
		banner.id = "geocoach-status";
		banner.setAttribute("role", "status");
		Object.assign(banner.style, {
			position: "fixed",
			left: "16px",
			bottom: "16px",
			zIndex: "100000",
			maxWidth: "360px",
			padding: "10px 14px",
			borderRadius: "7px",
			font: "13px/1.5 system-ui",
			boxShadow: "0 2px 12px #0003",
			pointerEvents: "none",
		});
		document.body.append(banner);
	}
	banner.textContent = `GeoCoach: ${text}`;
	banner.style.background = confirmed ? "#e5f5ef" : "#fff3dc";
	banner.style.color = confirmed ? "#165343" : "#69440b";
}

async function flush() {
	const response = await send({ type: "recording-status", page: pageStatus() });
	showRecordingStatus(
		response?.text ?? "Connection lost. Check the extension.",
		response?.recording === true,
	);
	recording = response?.enabled === true;
	if (!recording || !state?.supported || statePath !== location.pathname) {
		renderReviewButton();
		return;
	}
	readCard();
	for (const completed of state.completed) {
		const key = `${state.gameId}:${completed.round}`;
		await update(
			{
				gameId: state.gameId,
				mapName: state.mapName,
				round: completed.round,
				result: completed.result,
				meta: pendingMeta.get(key),
			},
			key,
		);
	}
	renderReviewButton();
	if (canCapture() && state.activeRound) {
		const reason =
			`${state.gameId}:${state.activeRound}` === startKey
				? "periodic"
				: "start";
		if (Date.now() - lastCaptured > 6000) await capture(reason);
	}
}

function renderReviewButton() {
	let link = document.getElementById(
		"geocoach-review",
	) as HTMLAnchorElement | null;
	if (
		!recording ||
		!state?.supported ||
		statePath !== location.pathname ||
		state.activeRound ||
		!state.completed.length
	) {
		link?.remove();
		return;
	}
	if (!link) {
		link = document.createElement("a");
		link.id = "geocoach-review";
		link.target = "_blank";
		link.rel = "noopener noreferrer";
		link.textContent = "Review";
		Object.assign(link.style, {
			position: "fixed",
			right: "24px",
			top: "24px",
			zIndex: "100000",
			background: "#fff",
			color: "#222",
			border: "1px solid #ccc",
			borderRadius: "7px",
			padding: "10px 14px",
			font: "14px system-ui",
			textDecoration: "none",
		});
		document.body.append(link);
	}
	link.href = `${APP_URL}/#game=${state.gameId}&round=${cardRound ?? state.completed.at(-1)?.round}`;
}

window.addEventListener("message", (event) => {
	if (
		event.source !== window ||
		event.origin !== location.origin ||
		event.data?.source !== "geocoach-page"
	)
		return;
	const data = event.data as PageEvent;
	if (data.type === "state") {
		if (data.state.gameId !== state?.gameId) cardRound = undefined;
		else if (data.state.activeRound !== state?.activeRound) {
			cardRound =
				state?.activeRound &&
				data.state.completed.some((round) => round.round === state?.activeRound)
					? state.activeRound
					: undefined;
		}
		state = data.state;
		statePath = data.path;
	}
	if (data.type === "meta")
		pendingMeta.set(`${data.gameId}:${data.round}`, data.meta);
});
document.addEventListener("pointerup", scheduleCapture, {
	passive: true,
	capture: true,
});
document.addEventListener("wheel", scheduleCapture, {
	passive: true,
	capture: true,
});
document.addEventListener("keyup", scheduleCapture);
document.addEventListener(
	"click",
	(event) => {
		const target =
			event.target instanceof Element
				? event.target.closest("[title], [aria-label]")
				: null;
		const label =
			target?.getAttribute("title") ?? target?.getAttribute("aria-label") ?? "";
		const row =
			event.target instanceof Element
				? event.target.closest('[class*="result-list_listItemWrapper"]')
				: null;
		const rowNumber = row
			?.querySelector('[class*="result-list_roundNumber"]')
			?.textContent?.trim();
		const round =
			/View meta for round (\d)/i.exec(label)?.[1] ??
			(label === "View meta for this round" ? rowNumber : undefined);
		if (round) {
			cardRound = Number(round);
			setTimeout(readCard, 1000);
		}
	},
	true,
);
ext.runtime.onMessage.addListener((message, _sender, respond) => {
	if (message.type === "page-status") {
		respond(pageStatus());
	}
	if (message.type === "capture-valid") {
		respond(
			Boolean(
				canCapture() &&
					state &&
					state.gameId === message.gameId &&
					state.activeRound === message.round &&
					location.pathname === message.path,
			),
		);
	}
});
let flushing = false;
setInterval(() => {
	if (flushing) return;
	flushing = true;
	void flush()
		.catch(() => {
			showRecordingStatus(
				"Connection lost. Reload the extension and refresh this tab.",
				false,
			);
		})
		.finally(() => {
			flushing = false;
		});
}, 1200);
