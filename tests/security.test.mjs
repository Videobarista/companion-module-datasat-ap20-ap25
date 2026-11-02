import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { boot, logged, noVariables, wait, waitFor } from './helpers/harness.mjs'

const PASSWORD = 'Geheim123'

function allLogText(instance) {
	return instance.logs.map((entry) => entry.message).join('\n')
}

describe('password', () => {
	it('is read from the secrets, sent once, and never logged', async () => {
		const { unit, instance, stop } = await boot({ password: PASSWORD }, {}, { password: PASSWORD })
		try {
			await waitFor(() => instance.vars.fader === '7.0', 3000, 'authenticated poll')
			assert.ok(unit.received.includes(`AUTH ${PASSWORD}`))
			assert.ok(!allLogText(instance).includes(PASSWORD))
			assert.ok(logged(instance, 'debug', 'TX: @AUTH ****'))
		} finally {
			await stop()
		}
	})

	it('stops on a wrong password', async () => {
		const { unit, instance, stop } = await boot({ password: PASSWORD }, {}, { password: 'wrong' })
		try {
			await waitFor(() => instance.statuses.some((s) => s.status === 'authentication_failure'), 3000, 'auth failure')
			await wait(800)
			assert.ok(!unit.received.includes('FADER'))
			assert.ok(!allLogText(instance).includes('wrong'))
		} finally {
			await stop()
		}
	})

	it('warns when the Setup password is used', async () => {
		const { instance, stop } = await boot({ password: PASSWORD, authLevel: 'SETUP' }, {}, { password: PASSWORD })
		try {
			await waitFor(() => logged(instance, 'warn', 'Setup password'), 3000, 'setup warning')
		} finally {
			await stop()
		}
	})

	it('refuses a password with a line break or one that is too long', async () => {
		for (const password of ['abc\r@POWER 0', 'x'.repeat(65)]) {
			const { unit, instance, stop } = await boot({}, {}, { password })
			try {
				assert.equal(instance.statuses.at(-1).status, 'bad_config')
				await wait(200)
				assert.equal(unit.received.length, 0, 'nothing is sent')
			} finally {
				await stop()
			}
		}
	})

	it('cannot be sent through Send Custom Command', async () => {
		const { unit, instance, stop } = await boot()
		try {
			await waitFor(() => instance.vars.fader === '7.0', 3000, 'first poll')
			await instance.defs.actions.customCommand.callback({ options: { command: `AUTH ${PASSWORD}` } }, noVariables)
			await instance.defs.actions.customCommand.callback({ options: { command: `@auth ${PASSWORD}` } }, noVariables)
			await wait(300)
			assert.ok(!unit.received.some((c) => c.toUpperCase().startsWith('AUTH')))
			assert.ok(logged(instance, 'warn', 'cannot send AUTH'))
			assert.ok(!allLogText(instance).includes(PASSWORD))
		} finally {
			await stop()
		}
	})
})

describe('command injection', () => {
	it('refuses a format name with a line break from a variable', async () => {
		const { unit, instance, stop } = await boot()
		try {
			await waitFor(() => instance.vars.fader === '7.0', 3000, 'first poll')
			const fromVariable = { parseVariablesInString: async () => 'Hdmi 1\r@POWER 0' }
			await instance.defs.actions.setFormat.callback({ options: { format: '$(internal:x)' } }, fromVariable)
			await instance.defs.actions.runMacro.callback({ options: { macro: '$(internal:x)' } }, fromVariable)
			await instance.defs.actions.customCommand.callback({ options: { command: 'FADER 70\r@POWER 0' } }, noVariables)
			await wait(500)
			assert.ok(!unit.received.includes('POWER 0'), 'no second command reached the unit')
			assert.ok(!unit.received.some((c) => c.startsWith('FORMAT Hdmi 1')))
			assert.equal(unit.power, 1)
			assert.ok(logged(instance, 'warn', 'control characters'))
		} finally {
			await stop()
		}
	})

	it('keeps numbers within range and does not send what is not a number', async () => {
		const { unit, instance, stop } = await boot()
		try {
			await waitFor(() => instance.vars.fader === '7.0', 3000, 'first poll')
			const actions = instance.defs.actions
			actions.setFader.callback({ options: { level: 'abc' } })
			actions.setFader.callback({ options: { level: 99 } })
			actions.setMonitorLevel.callback({ options: { level: 70.6 } })
			actions.gpioPulse.callback({ options: { gpio: 99 } })
			actions.faderRelative.callback({ options: { delta: Number.NaN } })
			await wait(600)
			assert.ok(!unit.received.some((c) => c.includes('NaN')))
			assert.ok(unit.received.includes('FADER 100'))
			assert.ok(unit.received.includes('MONITORLEVEL 71'))
			assert.ok(!unit.received.some((c) => c.startsWith('PULSE')))
		} finally {
			await stop()
		}
	})

	it('accepts a custom command with a leading @', async () => {
		const { unit, instance, stop } = await boot()
		try {
			await waitFor(() => instance.vars.fader === '7.0', 3000, 'first poll')
			await instance.defs.actions.customCommand.callback({ options: { command: '@HEALTH TEMPERATURE' } }, noVariables)
			await waitFor(() => logged(instance, 'info', 'Response to @HEALTH TEMPERATURE'), 3000, 'response logged')
			assert.ok(!unit.received.includes('@HEALTH TEMPERATURE'))
		} finally {
			await stop()
		}
	})
})

describe('untrusted answers from the unit', () => {
	it('drops data that never ends in a line break and keeps working', async () => {
		const { simulated, instance, stop } = await boot()
		try {
			await waitFor(() => instance.vars.fader === '7.0', 3000, 'first poll')
			simulated.push('X'.repeat(20000))
			await waitFor(() => logged(instance, 'warn', 'did not end in a line break'), 3000, 'overflow warning')
			assert.ok(instance.rxBuffer.length < 20000)
			instance.defs.actions.setFader.callback({ options: { level: 3 } })
			await waitFor(() => instance.vars.fader === '3.0', 4000, 'still working')
		} finally {
			await stop()
		}
	})

	it('uses at most 100 names and skips names that are too long', async () => {
		const formats = [...Array.from({ length: 150 }, (_, i) => `F${i}`), 'x'.repeat(80)]
		const { instance, stop } = await boot({ formats })
		try {
			await waitFor(() => instance.formats.length > 0, 3000, 'formats')
			assert.equal(instance.formats.length, 100)
			assert.ok(instance.formats.every((name) => name.length <= 64))
			assert.ok(Object.keys(instance.defs.presets).filter((k) => k.startsWith('format_')).length <= 100)
			assert.ok(logged(instance, 'warn', 'left out'))
		} finally {
			await stop()
		}
	})

	it('hides the MAC address and serial number in every log line', async () => {
		const { instance, stop } = await boot()
		try {
			await waitFor(() => instance.vars.serial === '02635', 3000, 'serial')
			await instance.defs.actions.customCommand.callback({ options: { command: 'SYSTEM' } }, noVariables)
			await instance.defs.actions.customCommand.callback({ options: { command: 'SERIALNO' } }, noVariables)
			await waitFor(() => logged(instance, 'info', 'Response to @SERIALNO'), 3000, 'responses logged')
			const text = allLogText(instance)
			assert.ok(!text.includes('00:50:C2'))
			assert.ok(!text.includes('02635'))
		} finally {
			await stop()
		}
	})
})

describe('load on the unit', () => {
	it('lets at most 20 button presses wait and warns about the rest', async () => {
		const { instance, stop } = await boot({ ignore: ['MUTED'] }, { pollInterval: 0, healthInterval: 0 })
		try {
			await waitFor(() => instance.vars.fader === '7.0', 3000, 'first poll')
			await waitFor(() => instance.inflight === null, 3000, 'idle')
			for (let i = 0; i < 30; i++) instance.sendCommand('MUTED 1')
			assert.equal(instance.userQueue.length, 20)
			assert.ok(logged(instance, 'warn', 'not keeping up'))
		} finally {
			await stop()
		}
	})

	it('raises a poll interval that is too short to 500 ms', async () => {
		const { unit, instance, stop } = await boot({}, { pollInterval: 20, healthInterval: 1 })
		try {
			assert.ok(logged(instance, 'warn', 'raised to the minimum of 500 ms'))
			assert.ok(logged(instance, 'warn', 'raised to the minimum of 10 s'))
			await waitFor(() => instance.pollActive, 3000, 'polling started')
			const before = unit.received.filter((c) => c === 'POWER').length
			await wait(2000)
			const polls = unit.received.filter((c) => c === 'POWER').length - before
			assert.ok(polls <= 5, `at most about 4 polls in 2 s, got ${polls}`)
		} finally {
			await stop()
		}
	})

	it('refuses an IP address with characters that do not belong in it', async () => {
		const { instance, stop } = await boot({}, { host: '10.0.0.5; rm -rf /' })
		try {
			assert.equal(instance.statuses.at(-1).status, 'bad_config')
			assert.equal(instance.socket, null)
		} finally {
			await stop()
		}
	})
})
