import { join } from "node:path";
import sharp from "sharp";
import type { Capture } from "../shared/schema";

function difference(a: Buffer, b: Buffer) {
	let total = 0;
	for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
	return total / a.length;
}

export async function selectViews(root: string, captures: Capture[]) {
	const previews = await Promise.all(
		captures.map((capture) =>
			sharp(join(root, "images", capture.file))
				.resize(32, 24, { fit: "fill" })
				.removeAlpha()
				.toColourspace("srgb")
				.raw()
				.toBuffer(),
		),
	);
	if (!captures.length) return [];
	const selected = [0];
	while (selected.length < 6) {
		let best = -1;
		let bestDifference = 12;
		for (let i = 0; i < captures.length; i++) {
			if (selected.includes(i)) continue;
			const distance = Math.min(
				...selected.map((index) => difference(previews[i], previews[index])),
			);
			if (distance > bestDifference) {
				best = i;
				bestDifference = distance;
			}
		}
		if (best === -1) break;
		selected.push(best);
	}
	return selected.sort((a, b) => a - b).map((index) => captures[index]);
}
