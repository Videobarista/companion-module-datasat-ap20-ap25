// A simulated AP20/AP25 that answers like the real units do (as seen on an AP20 with firmware 105.09):
// - lists come back with the command name in front ("FORMATNAMES A,B,") and an empty list as "MACRONAMES"
// - unknown commands get "BadCommand"
// - without a valid AUTH everything except SYSTEM and IDENTIFY gets "SECERR"
import net from 'node:net'

export async function startSimulatedUnit(options = {}) {
	const unit = {
		power: options.power ?? 1,
		fader: 70,
		muted: 0,
		format: 'Hdmi 1',
		monitorLevel: 40,
		monitorMute: 0,
		supportsPower: options.supportsPower ?? true,
		supportsNames: options.supportsNames ?? true,
		password: options.password ?? '',
		echoLists: options.echoLists ?? true,
		trailingComma: options.trailingComma ?? true,
		formats: options.formats ?? ['AES EBU 2ch', 'Hdmi 1', 'Hdmi 1 Neo6', 'Nonsync 2 pro', 'Spdif ', 'Toslink A'],
		macros: options.macros ?? ['FORMAT_1', 'HDMI 1'],
		silentForMs: options.silentForMs ?? 0,
		delays: options.delays ?? {},
		ignore: new Set(options.ignore ?? []),
		h336: '1,3.21,5.04,14.9,-15.2,0.0,1',
		temperature: '41,39,40',
		received: [],
	}

	const sockets = new Set()

	const server = net.createServer((socket) => {
		sockets.add(socket)
		socket.on('close', () => sockets.delete(socket))
		socket.on('error', () => sockets.delete(socket))

		const connectedAt = Date.now()
		let authorised = unit.password === ''
		let buffer = ''

		const reply = (text) => socket.write(`${text}\r`)
		const replyAs = (keyword, text) => {
			const delay = unit.delays[keyword]
			if (delay) setTimeout(() => reply(text), delay)
			else reply(text)
		}
		const list = (keyword, names) => {
			const body = names.join(',') + (unit.trailingComma && names.length > 0 ? ',' : '')
			if (!unit.echoLists) return body
			return body === '' ? keyword : `${keyword} ${body}`
		}

		socket.on('data', (data) => {
			buffer += data.toString()
			let index
			while ((index = buffer.indexOf('\r')) >= 0) {
				const line = buffer.slice(0, index)
				buffer = buffer.slice(index + 1)
				const command = line.replace(/^@/, '')
				unit.received.push(command)

				if (Date.now() - connectedAt < unit.silentForMs) continue

				const [keyword, ...rest] = command.split(' ')
				const argument = rest.join(' ')
				if (unit.ignore.has(keyword)) continue

				if (keyword === 'AUTH') {
					if (argument === unit.password) {
						authorised = true
						reply(options.authLevel === 'SETUP' ? 'AUTH SETUP' : 'AUTH OP')
					} else {
						reply('AUTH SECERR')
					}
					continue
				}
				if (!authorised && keyword !== 'SYSTEM' && keyword !== 'IDENTIFY') {
					reply('SECERR')
					continue
				}

				switch (keyword) {
					case 'SYSTEM':
						socket.write('VER 105.09\nVER_DATE Tue Jun 9 12:27:16 PDT 2020\nMAC 00:50:C2:B2:D6:81\r\0')
						break
					case 'SERIALNO':
						reply('SERIALNO 02635')
						break
					case 'POWER':
						if (!unit.supportsPower) {
							reply('BadCommand')
							break
						}
						if (argument !== '') unit.power = Number(argument)
						replyAs('POWER', `POWER ${unit.power}`)
						break
					case 'FORMATNAMES':
						if (unit.supportsNames) replyAs('FORMATNAMES', list('FORMATNAMES', unit.formats))
						else reply('BadCommand')
						break
					case 'MACRONAMES':
						if (unit.supportsNames) replyAs('MACRONAMES', list('MACRONAMES', unit.macros))
						else reply('BadCommand')
						break
					case 'FADER':
						if (argument !== '') unit.fader = Number(argument)
						reply(`FADER ${unit.fader}`)
						break
					case 'MUTED':
						if (argument !== '') unit.muted = Number(argument)
						reply(`MUTED ${unit.muted}`)
						break
					case 'FORMAT':
						// The unit trims the name it reports
						if (argument !== '') unit.format = argument.trim()
						reply(`FORMAT ${unit.format}`)
						break
					case 'MONITORLEVEL':
						if (argument !== '') unit.monitorLevel = Number(argument)
						reply(`MONITORLEVEL ${unit.monitorLevel}`)
						break
					case 'MONITORMUTE':
						if (argument !== '') unit.monitorMute = Number(argument)
						reply(`MONITORMUTE ${unit.monitorMute}`)
						break
					case 'HEALTH':
						if (argument === 'TEMPERATURE') reply(`HEALTH TEMPERATURE ${unit.temperature}`)
						else if (argument === 'H331VOLTS') reply('HEALTH H331VOLTS 1,3.24,5.00,15.0,-15.0,-5.1')
						else if (argument === 'H332VOLTS') reply('HEALTH H332VOLTS 1,3.25,4.98,14.9,-14.9,-5.1')
						else if (argument === 'H335VOLTS') reply('HEALTH H335VOLTS 1,3.22,1.30')
						else if (argument === 'H336VOLTS') reply(`HEALTH H336VOLTS ${unit.h336}`)
						else if (argument === 'H338VOLTS') reply('HEALTH H338VOLTS NA')
						else reply('BadCommand')
						break
					case 'SCR':
					case 'PULSE':
						reply('OK')
						break
					case 'RUNMACRO':
						reply(unit.macros.includes(argument) ? 'OK' : 'ERR no macro')
						break
					default:
						reply('BadCommand')
				}
			}
		})
	})

	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

	return {
		unit,
		port: server.address().port,
		/** Send raw data to every connected client, e.g. to test oversized or malformed answers. */
		push(text) {
			for (const socket of sockets) socket.write(text)
		},
		close() {
			for (const socket of sockets) socket.destroy()
			return new Promise((resolve) => server.close(() => resolve()))
		},
	}
}
