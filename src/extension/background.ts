import { APP_URL, roundUpdateSchema, captureSchema } from "../shared/schema";
import { ext } from "./browser";
import {
	pageStatusSchema,
	recordingStatus,
	type RecordingTab,
} from "../shared/recording";

export async function localRequest(
	path: string,
	body?: unknown,
	method?: string,
) {
	const { token } = await ext.storage.local.get("token");
	const response = await fetch(`${APP_URL}${path}`, {
		method: method ?? (body ? "POST" : "GET"),
		headers: {
			Authorization: `Bearer ${token ?? ""}`,
			"Content-Type": "application/json",
		},
		body: body ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(path === "/api/recording" ? 3000 : 15000),
	});
	if (!response.ok)
		throw new Error(
			(await response.json()).error ?? `Local app returned ${response.status}`,
		);
	return response.json();
}

let installation: Promise<string> | undefined;
function installationId() {
	installation ??= ext.storage.local
		.get("installationId")
		.then(async (stored) => {
			if (stored.installationId) return stored.installationId as string;
			const id = crypto.randomUUID();
			await ext.storage.local.set({ installationId: id });
			return id;
		});
	return installation;
}

async function reportTab(tab: chrome.tabs.Tab, page: unknown) {
	const tabId = tab.id;
	if (!tabId || !tab.url) throw new Error("Tab is missing.");
	const saved = await ext.storage.local.get([
		`recording:${tabId}`,
		`error:${tabId}`,
		`capture:${tabId}`,
	]);
	const report: RecordingTab = {
		...pageStatusSchema.parse(page),
		id: `${await installationId()}:${tabId}`,
		tabId,
		browser: ext.runtime.getURL("").startsWith("moz-extension:")
			? "Firefox"
			: "Chrome",
		title: tab.title ?? "GeoGuessr",
		url: tab.url,
		enabled: saved[`recording:${tabId}`] === true,
		error: saved[`error:${tabId}`] as string | undefined,
		lastCapture: saved[`capture:${tabId}`] as RecordingTab["lastCapture"],
	};
	await localRequest("/api/recording", report);
	const status = recordingStatus(report);
	let badge = "";
	if (report.enabled) badge = "WAIT";
	if (status.recording) badge = "REC";
	await ext.action.setBadgeText({ tabId, text: badge });
	await ext.action.setBadgeBackgroundColor({
		tabId,
		color: status.recording ? "#23776b" : "#94600d",
	});
	return { enabled: report.enabled, ...status };
}

let capturing = false;
let lastCapture = 0;
ext.runtime.onMessage.addListener((message, sender, respond) => {
	const handle = async () => {
		if (
			message.type === "popup-status" &&
			!sender.tab &&
			sender.id === ext.runtime.id
		) {
			const tab = await ext.tabs.get(message.tabId);
			if (!tab.url || !/^https:\/\/(www\.)?geoguessr\.com\//.test(tab.url))
				throw new Error("Open GeoGuessr to record.");
			const page = await ext.tabs.sendMessage(message.tabId, {
				type: "page-status",
			});
			return reportTab(tab, page);
		}
		const tab = sender.tab;
		const tabId = tab?.id;
		if (
			!tabId ||
			!tab?.url ||
			!/^https:\/\/(www\.)?geoguessr\.com\//.test(tab.url)
		)
			throw new Error("Unsupported tab.");
		const key = `recording:${tabId}`;
		const enabled = (await ext.storage.local.get(key))[key] === true;
		if (message.type === "recording-status") {
			try {
				return await reportTab(tab, message.page);
			} catch (error) {
				await ext.action.setBadgeText({ tabId, text: enabled ? "!" : "" });
				return {
					enabled,
					recording: false,
					text: `Not connected to the review app. ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		}
		if (!enabled) return { ok: false };
		try {
			if (message.type === "round") {
				const input = roundUpdateSchema.parse(message.input);
				await localRequest("/api/rounds", input);
				return { ok: true };
			}
			if (message.type === "capture") {
				if (capturing || Date.now() - lastCapture < 700) return { ok: false };
				const liveTab = await ext.tabs.get(tabId);
				if (!liveTab.active || liveTab.discarded) return { ok: false };
				capturing = true;
				try {
					lastCapture = Date.now();
					const image = await ext.tabs.captureVisibleTab(tab.windowId, {
						format: "jpeg",
						quality: 90,
					});
					const valid = await ext.tabs.sendMessage(tabId, {
						type: "capture-valid",
						gameId: message.input.gameId,
						round: message.input.round,
						path: new URL(tab.url).pathname,
					});
					if (!valid) return { ok: false };
					const input = captureSchema.parse({ ...message.input, image });
					const result = await localRequest("/api/captures", input);
					if (!result.stored) return { ok: false };
					await ext.storage.local.set({
						[`capture:${tabId}`]: {
							gameId: input.gameId,
							round: input.round,
							receivedAt: Date.now(),
						},
					});
					await ext.action.setBadgeText({ tabId, text: "REC" });
					await ext.action.setBadgeBackgroundColor({ tabId, color: "#23776b" });
					await ext.storage.local.remove(`error:${tabId}`);
					return { ok: true };
				} finally {
					capturing = false;
				}
			}
			throw new Error("Unknown extension message.");
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			const needsClick = /missing activeTab permission/i.test(detail);
			await ext.storage.local.set({
				[`error:${tabId}`]: needsClick
					? "Click GeoCoach to resume screenshots."
					: detail,
			});
			await ext.action.setBadgeText({
				tabId,
				text: needsClick ? "PAUSE" : "!",
			});
			await ext.action.setBadgeBackgroundColor({ tabId, color: "#bd593f" });
			throw error;
		}
	};
	void handle().then(respond, (error) =>
		respond({ error: String(error.message ?? error) }),
	);
	return true;
});
ext.tabs.onRemoved.addListener((tabId) => {
	void ext.storage.local.remove([
		`recording:${tabId}`,
		`error:${tabId}`,
		`capture:${tabId}`,
	]);
	void installationId()
		.then((id) =>
			localRequest(`/api/recording/${id}:${tabId}`, undefined, "DELETE"),
		)
		.catch(() => {});
});
ext.runtime.onStartup.addListener(() => {
	void ext.storage.local
		.get(null)
		.then((all) =>
			ext.storage.local.remove(
				Object.keys(all).filter(
					(k) =>
						k.startsWith("recording:") ||
						k.startsWith("error:") ||
						k.startsWith("capture:"),
				),
			),
		);
});
