import { build } from "esbuild";
import { mkdir, writeFile, copyFile, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist/web", { recursive: true });
await build({
	entryPoints: ["src/server/index.ts"],
	outfile: "dist/server.js",
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	sourcemap: true,
});
await build({
	entryPoints: ["src/web/index.tsx"],
	outfile: "dist/web/app.js",
	bundle: true,
	format: "esm",
	minify: true,
	sourcemap: true,
});
await copyFile("src/web/index.html", "dist/web/index.html");
for (const browser of ["chrome", "firefox"]) {
	const outdir = `dist/extension-${browser}`;
	await mkdir(outdir, { recursive: true });
	await build({
		entryPoints: [
			"src/extension/background.ts",
			"src/extension/content.ts",
			"src/extension/page.ts",
			"src/extension/popup.ts",
		],
		outdir,
		bundle: true,
		format: "iife",
		target: "es2022",
		sourcemap: true,
	});
	await copyFile("src/extension/popup.html", `${outdir}/popup.html`);
	const manifest = {
		manifest_version: 3,
		name: "GeoCoach",
		version: "0.1.0",
		description: "Record and review single-player GeoGuessr rounds locally.",
		permissions: ["activeTab", "storage"],
		host_permissions: [
			"https://www.geoguessr.com/*",
			"https://geoguessr.com/*",
			"http://127.0.0.1/*",
		],
		action: { default_popup: "popup.html", default_title: "GeoCoach" },
		background:
			browser === "chrome"
				? { service_worker: "background.js" }
				: { scripts: ["background.js"] },
		content_scripts: [
			{
				matches: ["https://www.geoguessr.com/*", "https://geoguessr.com/*"],
				js: ["page.js"],
				run_at: "document_start",
				world: "MAIN",
			},
			{
				matches: ["https://www.geoguessr.com/*", "https://geoguessr.com/*"],
				js: ["content.js"],
				run_at: "document_start",
			},
		],
	};
	if (browser === "firefox")
		manifest.browser_specific_settings = {
			gecko: {
				id: "geocoach@local.turner",
				strict_min_version: "128.0",
			},
		};
	await writeFile(`${outdir}/manifest.json`, JSON.stringify(manifest, null, 2));
}
console.log("Built review app, local server, and Chrome + Firefox extensions.");
