import { parseGame } from "./game";
import type { Meta, PageState, PageEvent } from "../shared/schema";

type MetaData = {
	country?: string;
	metaName?: string;
	note?: string;
	footer?: string;
	images?: string[];
};
declare global {
	interface Window {
		geometaMetaCache?: Map<string, MetaData>;
		__geocoachPage?: boolean;
	}
}

if (!window.__geocoachPage) {
	window.__geocoachPage = true;
	let state: PageState | null = null;
	let loadedPath = "";
	const sentMeta = new Map<string, string>();
	const send = (event: PageEvent) => window.postMessage(event, location.origin);
	const accept = (data: unknown) => {
		if (!/^\/(game|challenge)\//.test(location.pathname)) return;
		const parsed = parseGame(data);
		if (
			location.pathname.startsWith("/game/") &&
			parsed?.gameId !== location.pathname.split("/")[2]
		)
			return;
		if (parsed) {
			state = parsed;
			loadedPath = location.pathname;
			send({
				source: "geocoach-page",
				type: "state",
				state,
				path: location.pathname,
			});
		}
	};
	const originalFetch = window.fetch;
	window.fetch = async function (...args) {
		const response = await originalFetch.apply(this, args);
		const url = new URL(
			args[0] instanceof Request ? args[0].url : String(args[0]),
			location.href,
		);
		if (
			url.origin === location.origin &&
			/^\/api\/v3\/(games|challenges)(\/|$)/.test(url.pathname)
		) {
			void response
				.clone()
				.json()
				.then(accept)
				.catch(() => {});
		}
		return response;
	};
	const snapshot = async () => {
		const path = location.pathname;
		if (!/^\/(game|challenge)\/[\w-]+/.test(path)) {
			state = null;
			loadedPath = "";
			return;
		}
		if (loadedPath !== path) {
			loadedPath = path;
			state = null;
			sentMeta.clear();
			const token = path.split("/")[2];
			try {
				if (path.startsWith("/challenge/")) {
					const initial = document.querySelector("#__NEXT_DATA__")?.textContent;
					if (initial)
						accept(JSON.parse(initial)?.props?.pageProps?.gameSnapshot);
					if (state) return;
				}
				const kind = path.startsWith("/challenge/") ? "challenges" : "games";
				const response = await originalFetch(`/api/v3/${kind}/${token}`);
				if (response.ok && location.pathname === path)
					accept(await response.json());
			} catch {
				loadedPath = "";
			}
		}
		if (!state) return;
		send({ source: "geocoach-page", type: "state", state, path });
		const mapId = document
			.querySelector<HTMLAnchorElement>(
				'.geometa-container a[href*="learnablemeta.com/maps/"]',
			)
			?.href.split("/maps/")[1];
		const cache = window.geometaMetaCache;
		if (!cache || !mapId) return;
		for (const completed of state.completed) {
			const data = cache.get(`${mapId}_${completed.result.panoId}`);
			if (!data) continue;
			const doc = new DOMParser().parseFromString(
				`${data.note ?? ""}<p>${data.footer ?? ""}</p>`,
				"text/html",
			);
			const meta: Meta = {
				title: [data.country, data.metaName].filter(Boolean).join(" - "),
				text: doc.body.textContent?.trim() ?? "",
				links: [...doc.querySelectorAll("a[href]")]
					.map((a) => a.getAttribute("href") ?? "")
					.filter((s) => s.startsWith("https://")),
				images: (data.images ?? []).filter((s) => s.startsWith("https://")),
				source: "cache",
			};
			const key = `${state.gameId}:${completed.round}`;
			const signature = JSON.stringify(meta);
			if (sentMeta.get(key) !== signature) {
				sentMeta.set(key, signature);
				send({
					source: "geocoach-page",
					type: "meta",
					gameId: state.gameId,
					round: completed.round,
					meta,
				});
			}
		}
	};
	setInterval(() => {
		void snapshot();
	}, 1000);
}
