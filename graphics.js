/**
 * Draws a horizontal level bar as a raw RGBA pixel buffer, for use as the image of an advanced feedback.
 * Pure function without Companion dependencies.
 */

// Companion buttons are 72 x 72 px; surfaces with larger keys report a larger size. Never allocate more.
const MAX_SIDE = 512

const TRACK = [48, 52, 58, 255]
const TICK = [255, 255, 255, 255]

/** 0xRRGGBB -> [r, g, b, 255] */
export function rgbFromNumber(color) {
	const value = Number.isFinite(color) ? color : 0x2ec4b6
	return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff, 255]
}

/**
 * @param {object} opts
 * @param {number} opts.width        button width reported by Companion
 * @param {number} opts.height       button height reported by Companion
 * @param {number} opts.fraction     filled part, 0 - 1
 * @param {number|null} opts.marker  position of a reference tick, 0 - 1, or null for none
 * @param {number} opts.color        fill colour as 0xRRGGBB
 * @param {'top'|'bottom'} opts.position
 * @returns {object} the advanced feedback result, or {} when there is nothing to draw
 */
export function drawLevelBar({ width, height, fraction, marker = null, color, position = 'bottom' }) {
	const w = Math.floor(Number(width))
	const h = Math.floor(Number(height))
	if (!Number.isFinite(w) || !Number.isFinite(h) || w < 8 || h < 8 || w > MAX_SIDE || h > MAX_SIDE) {
		return {}
	}

	const barHeight = Math.max(4, Math.round(h * 0.14))
	const margin = Math.max(2, Math.round(w * 0.06))
	const innerWidth = w - margin * 2
	const filled = Math.round(innerWidth * Math.min(1, Math.max(0, Number(fraction) || 0)))
	const tickX = marker === null ? -1 : margin + Math.round(innerWidth * Math.min(1, Math.max(0, marker)))
	const fill = rgbFromNumber(color)

	const pixels = new Uint8Array(w * barHeight * 4) // fully transparent to start with
	for (let y = 0; y < barHeight; y++) {
		for (let x = margin; x < margin + innerWidth; x++) {
			let rgba = x - margin < filled ? fill : TRACK
			if (tickX >= 0 && (x === tickX || x === tickX - 1)) rgba = TICK
			const i = (y * w + x) * 4
			pixels[i] = rgba[0]
			pixels[i + 1] = rgba[1]
			pixels[i + 2] = rgba[2]
			pixels[i + 3] = rgba[3]
		}
	}

	return {
		imageBuffer: Buffer.from(pixels).toString('base64'),
		imageBufferEncoding: { pixelFormat: 'RGBA' },
		imageBufferPosition: {
			x: 0,
			y: position === 'top' ? 1 : h - barHeight - 1,
			width: w,
			height: barHeight,
		},
	}
}
