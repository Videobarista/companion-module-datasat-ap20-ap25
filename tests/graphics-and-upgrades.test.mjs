import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { drawLevelBar } from '../graphics.js'
import { movePasswordToSecrets } from '../upgrades.js'

function pixelAt(result, x, y) {
	const pixels = Buffer.from(result.imageBuffer, 'base64')
	const i = (y * result.imageBufferPosition.width + x) * 4
	return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]]
}

describe('level bar', () => {
	it('draws an RGBA bar at the bottom of a 72 x 72 button', () => {
		const result = drawLevelBar({ width: 72, height: 72, fraction: 0.5, marker: 0.7, color: 0x2ec4b6 })
		const { x, y, width, height } = result.imageBufferPosition
		assert.equal(result.imageBufferEncoding.pixelFormat, 'RGBA')
		assert.equal(x, 0)
		assert.equal(width, 72)
		assert.ok(height >= 4 && y + height <= 72 && y > 50)
		assert.equal(Buffer.from(result.imageBuffer, 'base64').length, width * height * 4)
	})

	it('fills up to the level, shows the reference tick, and leaves the margins transparent', () => {
		const result = drawLevelBar({ width: 72, height: 72, fraction: 0.28, marker: 0.7, color: 0x2ec4b6 })
		assert.deepEqual(pixelAt(result, 6, 2), [0x2e, 0xc4, 0xb6, 255], 'filled part')
		assert.deepEqual(pixelAt(result, 40, 2), [48, 52, 58, 255], 'empty track')
		const tickX = 4 + Math.round(64 * 0.7)
		assert.deepEqual(pixelAt(result, tickX, 2), [255, 255, 255, 255], 'reference tick')
		assert.equal(pixelAt(result, 0, 2)[3], 0, 'margin is transparent')
	})

	it('can sit at the top', () => {
		const result = drawLevelBar({ width: 72, height: 72, fraction: 1, color: 0, position: 'top' })
		assert.equal(result.imageBufferPosition.y, 1)
	})

	it('draws nothing for a missing, tiny or oversized button', () => {
		assert.deepEqual(drawLevelBar({ width: undefined, height: 72, fraction: 1 }), {})
		assert.deepEqual(drawLevelBar({ width: 4, height: 4, fraction: 1 }), {})
		assert.deepEqual(drawLevelBar({ width: 5000, height: 72, fraction: 1 }), {})
	})

	it('keeps a level outside 0 - 1 inside the bar', () => {
		const over = drawLevelBar({ width: 72, height: 72, fraction: 5, color: 0x00ff00 })
		const under = drawLevelBar({ width: 72, height: 72, fraction: -1, color: 0x00ff00 })
		assert.deepEqual(pixelAt(over, 67, 1), [0, 255, 0, 255])
		assert.deepEqual(pixelAt(under, 4, 1), [48, 52, 58, 255])
	})
})

describe('upgrade to 2.2.0', () => {
	const empty = { actions: [], feedbacks: [] }

	it('moves the password from the config to the secrets', () => {
		const result = movePasswordToSecrets({}, { ...empty, config: { host: '10.0.0.5', password: 'Geheim123' }, secrets: null })
		assert.deepEqual(result.updatedConfig, { host: '10.0.0.5' })
		assert.deepEqual(result.updatedSecrets, { password: 'Geheim123' })
	})

	it('removes an empty password from the config without creating a secret', () => {
		const result = movePasswordToSecrets({}, { ...empty, config: { host: 'x', password: '' }, secrets: {} })
		assert.deepEqual(result.updatedConfig, { host: 'x' })
		assert.deepEqual(result.updatedSecrets, {})
	})

	it('does not overwrite a secret that is already set', () => {
		const result = movePasswordToSecrets({}, { ...empty, config: { password: 'old' }, secrets: { password: 'new' } })
		assert.equal(result.updatedSecrets.password, 'new')
	})

	it('changes nothing when there is no password in the config', () => {
		const result = movePasswordToSecrets({}, { ...empty, config: { host: 'x' }, secrets: null })
		assert.equal(result.updatedConfig, null)
		assert.equal(result.updatedSecrets, null)
	})
})
