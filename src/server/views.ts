import { join } from "node:path";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import type { Capture, CoachCrop, CropRegion } from "../shared/schema";

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

export async function cropView(
	root: string,
	capture: Capture,
	region: CropRegion,
): Promise<CoachCrop> {
	if (region.x + region.width > 1 || region.y + region.height > 1)
		throw new Error("The zoom region extends outside the original image.");
	const image = sharp(join(root, "images", capture.file));
	const { width, height } = await image.metadata();
	if (!width || !height) throw new Error("The source image has no dimensions.");
	const left = Math.min(width - 1, Math.floor(region.x * width));
	const top = Math.min(height - 1, Math.floor(region.y * height));
	const file = `crop-${randomUUID()}.png`;
	await image
		.extract({
			left,
			top,
			width: Math.max(
				1,
				Math.min(width - left, Math.round(region.width * width)),
			),
			height: Math.max(
				1,
				Math.min(height - top, Math.round(region.height * height)),
			),
		})
		.png()
		.toFile(join(root, "images", file));
	return { file, sourceCaptureId: capture.id, region };
}
