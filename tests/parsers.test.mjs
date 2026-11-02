import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
	LIMITS,
	classifyListResponse,
	hasControlChars,
	isAnswerTo,
	limitNames,
	maskCommand,
	parseHealth,
	parseNameList,
	redactForLog,
	sanitizeArg,
	stripListPrefix,
	toBoundedInt,
} from '../parsers.js'

describe('name lists', () => {
	it('reads the exact list a real AP20 sends', () => {
		const raw =
			'FORMATNAMES AES EBU 2ch,AES EBU 8ch,Hdmi 1,Hdmi 1 Neo6,Hdmi 2,Hdmi 3,Hdmi 4,Mic,Mono,Nonsync 1,Nonsync 2 pro,SR,Spdif ,Toslink A,Toslink B,'
		const names = parseNameList(stripListPrefix('FORMATNAMES', raw))
		assert.equal(names.length, 15)
		assert.equal(names[0], 'AES EBU 2ch')
		assert.equal(names[12], 'Spdif ', 'a trailing space is kept so the unit recognises the name')
	})

	it('reads an empty list and a list without the command echo', () => {
		assert.deepEqual(parseNameList(stripListPrefix('MACRONAMES', 'MACRONAMES')), [])
		assert.deepEqual(parseNameList(stripListPrefix('MACRONAMES', 'FORMAT_1,HDMI 1')), ['FORMAT_1', 'HDMI 1'])
	})

	it('keeps at most the maximum number of names and skips over-long or odd ones', () => {
		const names = [...Array.from({ length: 150 }, (_, i) => `F${i}`), 'x'.repeat(80), 'bad\u0001name']
		const { names: kept, skipped } = limitNames(names)
		assert.equal(kept.length, LIMITS.names)
		assert.equal(skipped, 52)
		assert.ok(kept.every((name) => name.length <= LIMITS.nameLength && !hasControlChars(name)))
	})

	it('classifies list answers', () => {
		assert.equal(classifyListResponse({ text: 'BadCommand' }, 'FORMATNAMES'), 'unsupported')
		assert.equal(classifyListResponse(null, 'FORMATNAMES'), 'unknown')
		assert.equal(classifyListResponse({ text: 'MACRONAMES' }, 'MACRONAMES'), 'list')
		assert.equal(classifyListResponse({ text: 'POWER 1' }, 'FORMATNAMES'), 'unknown')
		assert.equal(classifyListResponse({ text: 'SECERR' }, 'FORMATNAMES'), 'unknown')
	})
})

describe('answers belong to their own command', () => {
	it('accepts every answer of the real unit for its own command', () => {
		const pairs = [
			['SYSTEM', 'VER 105.09\nVER_DATE Mon Jan 6 10:20:30 PST 2020\nMAC 02:00:00:AA:BB:CC'],
			['SERIALNO', 'SERIALNO 12345'],
			['POWER', 'POWER 1'],
			['FORMATNAMES', 'FORMATNAMES AES EBU 2ch,Hdmi 1,'],
			['MACRONAMES', 'MACRONAMES'],
			['FORMAT Spdif ', 'FORMAT Spdif'],
			['HEALTH H338VOLTS', 'HEALTH H338VOLTS NA'],
			['AUTH secret', 'AUTH OP'],
			['RUNMACRO x', 'ERR no macro'],
			['VOLUME 350', 'BadCommand'],
			['SOMETHINGNEW', 'anything'],
		]
		for (const [cmd, text] of pairs) assert.equal(isAnswerTo(cmd, text), true, `${cmd} <- ${text}`)
	})

	it('does not take a late answer of another command', () => {
		assert.equal(isAnswerTo('FORMATNAMES', 'POWER 1'), false)
		assert.equal(isAnswerTo('MACRONAMES', 'FORMATNAMES AES EBU 2ch'), false)
		assert.equal(isAnswerTo('POWER', 'SERIALNO 12345'), false)
		assert.equal(isAnswerTo('FORMAT', 'FORMATNAMES A,B'), false)
	})
})

describe('health answers', () => {
	it('reads temperatures and rejects anything that is not a number', () => {
		assert.deepEqual(parseHealth('TEMPERATURE 41,39,40').temps, ['41', '39', '40'])
		assert.deepEqual(parseHealth('TEMPERATURE 41,<script>,9999').temps, ['41', null, null])
		assert.deepEqual(parseHealth('TEMPERATURE 41').temps, ['41', null, null])
	})

	it('reads board voltages, phantom power and CPU supply', () => {
		const h336 = parseHealth('H336VOLTS 1,3.21,5.04,14.9,-15.2,0.0,1')
		assert.equal(h336.ok, true)
		assert.equal(h336.phantomOn, false)
		assert.equal(h336.cpuOk, true)
		assert.equal(parseHealth('H338VOLTS NA').present, false)
	})

	it('ignores boards it does not know', () => {
		assert.equal(parseHealth('H999VOLTS 1,2,3'), null)
	})
})

describe('safe values', () => {
	it('removes control characters and caps the length', () => {
		assert.equal(sanitizeArg('Hdmi 1\r@POWER 0'), 'Hdmi 1@POWER 0')
		assert.equal(sanitizeArg('Spdif '), 'Spdif ')
		assert.equal(sanitizeArg('x'.repeat(100)).length, LIMITS.nameLength)
		assert.equal(hasControlChars('a\nb'), true)
		assert.equal(hasControlChars('a b'), false)
	})

	it('rounds and clamps numbers, and rejects what is not a number', () => {
		assert.equal(toBoundedInt(70.6, 0, 100), 71)
		assert.equal(toBoundedInt(-5, 0, 100), 0)
		assert.equal(toBoundedInt(250, 0, 100), 100)
		assert.equal(toBoundedInt('42', 0, 100), 42)
		assert.equal(toBoundedInt(Number.NaN, 0, 100), null)
		assert.equal(toBoundedInt('abc', 0, 100), null)
		assert.equal(toBoundedInt('', 0, 100), null)
		assert.equal(toBoundedInt(undefined, 0, 100), null)
	})

	it('hides the password, MAC address and serial number in log lines', () => {
		assert.equal(maskCommand('AUTH Geheim123'), 'AUTH ****')
		assert.equal(maskCommand('FADER 70'), 'FADER 70')
		const line = redactForLog('VER 105.09 | VER_DATE Mon Jan 6 10:20:30 PST 2020 | MAC 02:00:00:AA:BB:CC')
		assert.ok(!line.includes('02:00:00:AA'))
		assert.ok(line.includes('10:20:30'), 'a time of day is not mistaken for a MAC address')
		assert.equal(redactForLog('SERIALNO 12345'), 'SERIALNO ***')
		assert.equal(redactForLog('MAC 080077124578'), 'MAC ***')
	})
})
