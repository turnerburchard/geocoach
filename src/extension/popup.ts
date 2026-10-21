import { APP_URL } from "../shared/schema";
import { ext } from "./browser";

const status = document.querySelector<HTMLParagraphElement>("#status");
const record = document.querySelector<HTMLButtonElement>("#record");
const connect = document.querySelector<HTMLButtonElement>("#connect");
const input = document.querySelector<HTMLInputElement>("#token");
const pair = document.querySelector<HTMLDivElement>("#pair");
if (!status || !record || !connect || !input || !pair)
	throw new Error("Popup elements are missing.");
const statusEl = status,
	recordEl = record,
	connectEl = connect,
	inputEl = input,
	pairEl = pair;

async function check() {
	const { token } = await ext.storage.local.get("token");
	const response = await fetch(`${APP_URL}/api/games`, {
		headers: { Authorization: `Bearer ${token ?? ""}` },
		signal: AbortSignal.timeout(3000),
	});
	if (!response.ok) {
		pairEl.hidden = false;
		recordEl.hidden = true;
		statusEl.textContent = "Pairing code: review app → Setup.";
		return;
	}
	pairEl.hidden = true;
	const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
	if (
		!tab.id ||
		!tab.url ||
		!/^https:\/\/(www\.)?geoguessr\.com\//.test(tab.url)
	) {
		statusEl.textContent = "Open GeoGuessr to record.";
		return;
	}
	try {
		const result = await ext.runtime.sendMessage({
			type: "popup-status",
			tabId: tab.id,
		});
		if (result?.error) throw new Error(result.error);
		recordEl.hidden = false;
		recordEl.textContent = result.enabled
			? "Stop recording this tab"
			: "Start recording this tab";
		statusEl.textContent = `Already paired. Pairing survives closing tabs.\n\nThis tab: ${tab.title ?? "GeoGuessr"} (#${tab.id})\n${result.text}`;
	} catch {
		statusEl.textContent =
			"Already paired. Refresh this GeoGuessr tab to activate the extension.";
	}
}
connectEl.addEventListener("click", () => {
	void ext.storage.local
		.set({ token: inputEl.value.trim() })
		.then(check)
		.catch((error) => {
			statusEl.textContent = error.message;
		});
});
recordEl.addEventListener("click", async () => {
	const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
	if (!tab.id) return;
	const key = `recording:${tab.id}`;
	const enabled = (await ext.storage.local.get(key))[key] === true;
	await ext.storage.local.set({ [key]: !enabled });
	await ext.storage.local.remove([`error:${tab.id}`, `capture:${tab.id}`]);
	await ext.action.setBadgeText({ tabId: tab.id, text: enabled ? "" : "WAIT" });
	await ext.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#94600d" });
	await check();
});
void check().catch(() => {
	pairEl.hidden = true;
	recordEl.hidden = true;
	statusEl.textContent = "Server offline. Run pnpm dev.";
});

setInterval(() => {
	void check().catch(() => {
		pairEl.hidden = true;
		recordEl.hidden = true;
		statusEl.textContent = "Server offline. Run pnpm dev.";
	});
}, 2000);
