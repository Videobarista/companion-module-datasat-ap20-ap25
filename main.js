import { InstanceBase, InstanceStatus, TCPHelper, Regex, runEntrypoint } from '@companion-module/base'
import { getActions } from './actions.js'
import { getFeedbacks } from './feedbacks.js'
import { getVariables } from './variables.js'
import { getPresets } from './presets.js'
import { UpgradeScripts } from './upgrades.js'
import {
	BOARDS,
	LIMITS,
	classifyListResponse,
	cleanDeviceText,
	commandKeyword,
	hasControlChars,
	isAnswerTo,
	isAuthCommand,
	isBadCommand,
	isListCommand,
	limitNames,
	maskCommand,
	parseBinary,
	parseHealth,
	parseNameList,
	redactForLog,
	stripListPrefix,
} from './parsers.js'

const AP20_PORT = 14500

// How long to wait for the device to answer one command before moving on.
const RESPONSE_TIMEOUT_MS = 1500

// The unit needs about 15 seconds to become operational after @POWER 1 (TN-H413-01).
const POWER_WARMUP_MS = 15000

// Retry schedule for loading the format/macro lists when the device did not answer in time.
const NAMES_RETRY_MS = 10000
const NAMES_MAX_ATTEMPTS = 5

// Lower bounds for polling, so the module can never flood the unit (0 still switches polling off).
const MIN_POLL_INTERVAL_MS = 500
const MIN_HEALTH_INTERVAL_S = 10

// Repeated warnings of the same kind are written at most this often.
const WARN_THROTTLE_MS = 10000

// Longest line written to the debug log for one answer.
const MAX_LOG_LINE = 512

// A host name or IP address: letters, digits, dots, dashes and colons (IPv6) only.
const HOST_PATTERN = /^[A-Za-z0-9.:-]{1,253}$/

// Commands polled every poll interval while the unit is operating.
const STATUS_POLL = ['FADER', 'MUTED', 'FORMAT', 'MONITORLEVEL', 'MONITORMUTE']

// Commands polled every health interval while the unit is operating.
const HEALTH_POLL = ['HEALTH TEMPERATURE', ...BOARDS.map((board) => `HEALTH ${board}VOLTS`)]

/** 0 or less (or not a number) means off; anything else is raised to the minimum. */
function effectiveInterval(value, minimum) {
	const num = Number(value)
	if (!Number.isFinite(num) || num <= 0) return 0
	return Math.max(minimum, num)
}

class DatasatAP20Instance extends InstanceBase {
	constructor(internal) {
		super(internal)

		this.config = {}
		this.secrets = {}
		this.socket = null
		this.pollTimer = null
		this.pollActive = false
		this.rxBuffer = ''

		// Commands are sent one at a time so every answer can be matched to its command.
		// User actions go first, polling goes second.
		this.userQueue = []
		this.pollQueue = []
		this.inflight = null

		// Increases on every (dis)connect so stale async work can detect that it is outdated.
		this.session = 0
		this.authFailed = false
		this.setupLevelWarned = false
		this.errorLogged = false
		this.lastHealth = 0
		this.namesLoaded = false
		this.namesAttempts = 0
		this.namesTimer = null
		this.namesPromise = null
		this.warmupTimer = null

		// Fader commands from buttons that the unit has not answered yet, and the level they aim for.
		// Relative steps build on that level, so quick presses add up instead of all starting from the same value.
		this.pendingFaderCommands = 0
		this.faderTarget = null

		// Throttling of repeated warnings
		this.droppedCommands = 0
		this.lastDropWarning = 0
		this.lastOverflowWarning = 0

		// What this particular unit understands (detected after connecting).
		// power: true = works, false = the unit said BadCommand, null = not known yet (no usable answer so far).
		this.caps = { power: null, formatNames: false, macroNames: false }
		this.formats = []
		this.macros = []

		// Last known device state
		this.state = {
			fader: 0, // in tenths (0-100), e.g. 70 = 7.0
			muted: 0,
			format: '',
			monitorLevel: 0,
			monitorMute: 0,
			version: '',
			serial: '',
			temps: { t1: null, t2: null, t3: null },
			power: null, // 1 = operating, 0 = standby, null = unknown
			powerWarmupUntil: 0,
			boards: Object.fromEntries(BOARDS.map((board) => [board, { present: null, ok: null }])),
			phantomOn: null,
			cpuOk: null,
			powerOk: true,
		}
	}

	async init(config, _isFirstInit, secrets) {
		this.config = config ?? {}
		this.secrets = secrets ?? {}

		this.updateStatus(InstanceStatus.Connecting)

		this.setVariableDefinitions(getVariables())
		this.setVariableValues({
			power_state: '',
			power: '',
			power_faults: '',
			phantom: '',
			cpu_power: '',
		})
		this.refreshDefinitions()

		this.initConnection()
	}

	async configUpdated(config, secrets) {
		this.config = config ?? {}
		this.secrets = secrets ?? this.secrets
		this.initConnection()
	}

	async destroy() {
		this.teardownConnection()
		if (this.warmupTimer) {
			clearTimeout(this.warmupTimer)
			this.warmupTimer = null
		}
	}

	/** (Re)publish everything that depends on what the device reported. */
	refreshDefinitions() {
		this.setActionDefinitions(getActions(this))
		this.setFeedbackDefinitions(getFeedbacks(this))
		this.setPresetDefinitions(getPresets(this))
	}

	getConfigFields() {
		return [
			{
				type: 'textinput',
				id: 'host',
				label: 'AP20/AP25 IP Address',
				width: 8,
				regex: Regex.IP,
			},
			{
				// Stored in Companion's secrets store, not in the connection config that the web interface receives
				type: 'secret-text',
				id: 'password',
				label: 'NetCmd password (leave empty if none). The Setup password works too, but gives more rights than needed.',
				width: 8,
				default: '',
			},
			{
				type: 'number',
				id: 'pollInterval',
				label: `Status poll interval (ms, 0 = disable polling, minimum ${MIN_POLL_INTERVAL_MS})`,
				width: 8,
				default: 2000,
				min: 0,
				max: 60000,
			},
			{
				type: 'number',
				id: 'healthInterval',
				label: `Temperature / voltage poll interval (seconds, 0 = disable, minimum ${MIN_HEALTH_INTERVAL_S})`,
				width: 8,
				default: 30,
				min: 0,
				max: 3600,
			},
			{
				type: 'textinput',
				id: 'powerOnMacro',
				label: 'Fallback Power ON macro (only used if the unit does not support @POWER)',
				width: 6,
				default: '',
			},
			{
				type: 'textinput',
				id: 'standbyMacro',
				label: 'Fallback Standby macro (only used if the unit does not support @POWER)',
				width: 6,
				default: '',
			},
		]
	}

	getPassword() {
		const password = this.secrets?.password
		return typeof password === 'string' ? password : ''
	}

	pollIntervalMs() {
		return effectiveInterval(this.config.pollInterval, MIN_POLL_INTERVAL_MS)
	}

	healthIntervalMs() {
		return effectiveInterval(this.config.healthInterval, MIN_HEALTH_INTERVAL_S) * 1000
	}

	// ------------------------------------------------------------------
	// Connection handling
	// ------------------------------------------------------------------

	/** Check the connection settings before anything is sent. Returns an error message, or null when fine. */
	checkConfig() {
		const host = String(this.config.host ?? '').trim()
		if (host === '') return 'No IP address configured'
		if (!HOST_PATTERN.test(host)) return 'The IP address contains characters that are not allowed'

		const password = this.getPassword()
		if (password.length > LIMITS.passwordLength) return 'The password is too long'
		if (hasControlChars(password)) return 'The password contains characters that cannot be sent'

		return null
	}

	initConnection() {
		this.teardownConnection()
		this.resetDeviceKnowledge()

		const problem = this.checkConfig()
		if (problem) {
			this.updateStatus(InstanceStatus.BadConfig, problem)
			return
		}

		const requestedPoll = Number(this.config.pollInterval)
		if (requestedPoll > 0 && requestedPoll < MIN_POLL_INTERVAL_MS) {
			this.log('warn', `Status poll interval raised to the minimum of ${MIN_POLL_INTERVAL_MS} ms`)
		}
		const requestedHealth = Number(this.config.healthInterval)
		if (requestedHealth > 0 && requestedHealth < MIN_HEALTH_INTERVAL_S) {
			this.log('warn', `Temperature / voltage poll interval raised to the minimum of ${MIN_HEALTH_INTERVAL_S} s`)
		}

		this.updateStatus(InstanceStatus.Connecting)

		this.socket = new TCPHelper(String(this.config.host).trim(), AP20_PORT)

		this.socket.on('status_change', (status, message) => {
			this.log('debug', `Socket status: ${status} ${message ?? ''}`)
		})

		this.socket.on('error', (err) => {
			// The helper keeps retrying, so only report the first error of an outage at a visible level.
			this.log(this.errorLogged ? 'debug' : 'warn', `Network error: ${err.message}`)
			this.errorLogged = true
			this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
			this.handleDisconnect()
		})

		this.socket.on('end', () => {
			this.log('debug', 'Connection closed by the device')
			this.handleDisconnect()
		})

		this.socket.on('connect', () => {
			this.onConnect()
		})

		this.socket.on('data', (chunk) => {
			this.processData(chunk.toString())
		})
	}

	teardownConnection() {
		this.handleDisconnect()
		if (this.socket) {
			this.socket.destroy()
			this.socket = null
		}
	}

	resetDeviceKnowledge() {
		this.caps = { power: null, formatNames: false, macroNames: false }
		this.formats = []
		this.macros = []
		this.namesLoaded = false
		this.state.power = null
		this.state.powerWarmupUntil = 0
		this.authFailed = false
		this.refreshDefinitions()
	}

	/** Stop everything that belongs to the current connection. Safe to call repeatedly. */
	handleDisconnect() {
		this.session++
		this.stopPolling()
		if (this.namesTimer) {
			clearTimeout(this.namesTimer)
			this.namesTimer = null
		}
		this.failPending()
		this.namesPromise = null
		this.rxBuffer = ''
	}

	onConnect() {
		this.errorLogged = false
		this.log('info', `Connected to AP20/AP25 at ${this.config.host}:${AP20_PORT}`)
		this.updateStatus(InstanceStatus.Ok)
		this.rxBuffer = ''
		this.authFailed = false
		this.setupLevelWarned = false
		this.lastHealth = 0

		const session = ++this.session
		this.runConnectSequence(session).catch((err) => {
			this.log('error', `Startup sequence failed: ${err.message}`)
		})
	}

	/**
	 * Authenticate, read device info, detect what this unit supports, take a first snapshot and start polling.
	 * Every await is followed by a session check so a reconnect cleanly abandons an outdated run.
	 */
	async runConnectSequence(session) {
		const alive = () => session === this.session && !this.authFailed

		// Authentication is valid for the duration of this TCP connection
		const password = this.getPassword()
		if (password.length > 0) {
			await this.request(`AUTH ${password}`)
			if (!alive()) return
		}

		await this.request('SYSTEM')
		await this.request('SERIALNO')
		if (!alive()) return

		// @POWER is not in TN-H413 rev D but is accepted by real AP20/AP25 units.
		// Only a BadCommand answer means "not supported". No answer (for example while the unit is
		// starting up) leaves it open, and polling keeps asking until the unit answers.
		const power = await this.request('POWER')
		if (!alive()) return
		this.evaluatePower(power)
		const powerState = { true: 'supported', false: 'not supported' }[this.caps.power] ?? 'not known yet'
		this.log('debug', `Capability @POWER: ${powerState}${power ? ` (answer: ${power.text})` : ' (no answer)'}`)

		if (this.canProbeNames()) {
			await this.loadNames(session)
		} else if (this.state.power === 0) {
			this.log('info', 'The unit is in standby: format and macro lists are loaded after power on')
		} else {
			// No answer to @POWER yet, for example while the unit is being switched on or off
			this.log(
				'info',
				'The unit did not answer yet: format and macro lists are loaded as soon as it reports that it is on',
			)
		}
		if (!alive()) return

		await this.pollOnce()
		if (!alive()) return

		this.startPolling()
	}

	/** Format/macro lists can only be read reliably while the unit is operating. */
	canProbeNames() {
		return this.caps.power === false || (this.state.power === 1 && !this.isWarmingUp())
	}

	/**
	 * Ask the unit for its format and macro names. A BadCommand answer means "not supported" and is final;
	 * no answer at all is treated as "try again later".
	 * Returns true when both lists got a definitive answer.
	 */
	loadNames(session) {
		// The connect sequence and a power-on can ask at the same moment: share one run instead of asking twice.
		if (this.namesPromise) return this.namesPromise
		this.namesPromise = this.fetchNames(session).finally(() => {
			this.namesPromise = null
		})
		return this.namesPromise
	}

	async fetchNames(session) {
		const formats = await this.request('FORMATNAMES')
		if (session !== this.session) return false
		const macros = await this.request('MACRONAMES')
		if (session !== this.session) return false

		// 'unknown' (no answer, or an answer that does not fit) keeps what we had and is tried again later
		const formatsKind = classifyListResponse(formats, 'FORMATNAMES')
		const macrosKind = classifyListResponse(macros, 'MACRONAMES')
		if (formatsKind !== 'unknown') {
			this.caps.formatNames = formatsKind === 'list'
			this.formats = this.caps.formatNames ? this.readNameList('FORMATNAMES', formats.text, 'format') : []
		}
		if (macrosKind !== 'unknown') {
			this.caps.macroNames = macrosKind === 'list'
			this.macros = this.caps.macroNames ? this.readNameList('MACRONAMES', macros.text, 'macro') : []
		}
		this.refreshDefinitions()

		const yesNo = (flag) => (flag ? 'yes' : 'no')
		this.log(
			'debug',
			`Capabilities: FORMATNAMES ${yesNo(this.caps.formatNames)}, MACRONAMES ${yesNo(this.caps.macroNames)}`,
		)
		if (this.caps.formatNames || this.caps.macroNames) {
			this.log('info', `Loaded ${this.formats.length} formats and ${this.macros.length} macros from the unit`)
		}

		const complete = formatsKind !== 'unknown' && macrosKind !== 'unknown'
		this.namesLoaded = complete
		if (!complete) this.scheduleNamesRetry(session)
		return complete
	}

	/** Turn a list answer into names, within the limits of LIMITS.names and LIMITS.nameLength. */
	readNameList(cmd, text, kind) {
		const { names, skipped } = limitNames(parseNameList(stripListPrefix(cmd, text)))
		if (skipped > 0) {
			this.log(
				'warn',
				`${skipped} ${kind} name(s) from the unit were left out: at most ${LIMITS.names} names of at most ${LIMITS.nameLength} characters are used`,
			)
		}
		return names
	}

	scheduleNamesRetry(session) {
		if (this.namesAttempts >= NAMES_MAX_ATTEMPTS) return
		this.namesAttempts++
		if (this.namesTimer) clearTimeout(this.namesTimer)
		this.namesTimer = setTimeout(() => {
			this.namesTimer = null
			if (session !== this.session || this.namesLoaded || !this.canProbeNames()) return
			this.loadNames(session).catch((err) => {
				this.log('error', `Loading format and macro names failed: ${err.message}`)
			})
		}, NAMES_RETRY_MS)
	}

	/** Called when the unit has become operational and the lists are still missing. */
	ensureNames() {
		if (this.namesLoaded || !this.socket || !this.socket.isConnected) return
		this.namesAttempts = 0
		const session = this.session
		this.loadNames(session).catch((err) => {
			this.log('error', `Loading format and macro names failed: ${err.message}`)
		})
	}

	// ------------------------------------------------------------------
	// Polling
	// ------------------------------------------------------------------

	startPolling() {
		this.stopPolling()

		const interval = this.pollIntervalMs()
		if (interval <= 0) return

		this.pollActive = true
		const session = this.session

		const run = async () => {
			if (!this.pollActive || session !== this.session) return
			await this.pollOnce()
			if (!this.pollActive || session !== this.session) return
			this.pollTimer = setTimeout(run, interval)
		}

		this.pollTimer = setTimeout(run, interval)
	}

	stopPolling() {
		this.pollActive = false
		if (this.pollTimer) {
			clearTimeout(this.pollTimer)
			this.pollTimer = null
		}
	}

	/**
	 * One polling round. While the unit is in standby (or starting up) only the power state is read.
	 * A command that gets no answer ends the round, so an unresponsive unit costs one timeout per round.
	 */
	async pollOnce() {
		const session = this.session

		if (this.caps.power !== false) {
			const res = await this.request('POWER')
			if (res === null || session !== this.session) return
			this.evaluatePower(res)
			if (this.caps.power && (this.state.power !== 1 || this.isWarmingUp())) return
		}

		for (const cmd of STATUS_POLL) {
			const res = await this.request(cmd)
			if (res === null || session !== this.session) return
		}

		const healthMs = this.healthIntervalMs()
		if (healthMs > 0 && Date.now() - this.lastHealth >= healthMs) {
			this.lastHealth = Date.now()
			for (const cmd of HEALTH_POLL) {
				const res = await this.request(cmd)
				if (res === null || session !== this.session) return
			}
		}
	}

	/** Read what an answer to @POWER says about support. The power state itself is handled in parseResponse. */
	evaluatePower(res) {
		if (res === null) return
		if (isBadCommand(res)) {
			this.caps.power = false
		} else if (/^POWER\s+[01]$/i.test(res.text)) {
			this.caps.power = true
		}
	}

	// ------------------------------------------------------------------
	// Sending: one command at a time, answers matched to commands
	// ------------------------------------------------------------------

	/**
	 * Send a command and wait for its answer (one CR-terminated chunk).
	 * Resolves with { text, lines } or null when not connected, refused, or when no answer arrived in time.
	 * Never rejects.
	 */
	request(cmd, { user = false } = {}) {
		return new Promise((resolve) => {
			// Last line of defence: one command per line, never anything that could start a second command
			if (hasControlChars(cmd) || cmd.length > LIMITS.commandLength) {
				this.log(
					'warn',
					`Refused to send @${commandKeyword(cmd)}: it contains control characters or is longer than ${LIMITS.commandLength} characters`,
				)
				resolve(null)
				return
			}
			if (!this.socket || !this.socket.isConnected) {
				this.log('debug', `Not connected, cannot send: ${maskCommand(cmd)}`)
				resolve(null)
				return
			}
			if (user && this.userQueue.length >= LIMITS.userQueue) {
				this.noteDroppedCommand()
				resolve(null)
				return
			}
			const queue = user ? this.userQueue : this.pollQueue
			queue.push({ cmd, resolve, timer: null })
			this.pump()
		})
	}

	/** Too many button presses are waiting for the unit: drop this one and warn now and then. */
	noteDroppedCommand() {
		this.droppedCommands++
		const now = Date.now()
		if (now - this.lastDropWarning >= WARN_THROTTLE_MS) {
			this.log(
				'warn',
				`The unit is not keeping up: ${this.droppedCommands} command(s) dropped because ${LIMITS.userQueue} were already waiting`,
			)
			this.lastDropWarning = now
			this.droppedCommands = 0
		}
	}

	pump() {
		if (this.inflight) return

		const item = this.userQueue.shift() ?? this.pollQueue.shift()
		if (!item) return

		if (!this.socket || !this.socket.isConnected) {
			item.resolve(null)
			this.pump()
			return
		}

		this.inflight = item
		this.log('debug', `TX: @${maskCommand(item.cmd)}`)
		item.timer = setTimeout(() => {
			this.log('debug', `No response to @${commandKeyword(item.cmd)}`)
			this.finishInflight(null)
		}, RESPONSE_TIMEOUT_MS)

		Promise.resolve(this.socket.send(`@${item.cmd}\r`)).catch((err) => {
			this.log('warn', `Sending @${commandKeyword(item.cmd)} failed: ${err.message}`)
		})
	}

	finishInflight(response) {
		const item = this.inflight
		if (!item) return
		clearTimeout(item.timer)
		this.inflight = null
		item.resolve(response)
		this.pump()
	}

	/** Resolve everything that is still waiting with "no answer" (used when the connection goes away). */
	failPending() {
		const pending = [...this.userQueue, ...this.pollQueue]
		this.userQueue = []
		this.pollQueue = []
		if (this.inflight) {
			clearTimeout(this.inflight.timer)
			pending.unshift(this.inflight)
			this.inflight = null
		}
		for (const item of pending) item.resolve(null)
	}

	/**
	 * Fire-and-forget command for actions.
	 * Protocol: '@' + COMMAND [args] + <CR>  (TN-H413 rev D)
	 * With logResponse the answer is written to the Companion log, which helps when trying out commands.
	 */
	sendCommand(cmd, { logResponse = false, onDone = null } = {}) {
		this.request(cmd, { user: true })
			.finally(() => {
				if (onDone) onDone()
			})
			.then((res) => {
				if (res === null) {
					if (logResponse) this.log('info', `No response to @${maskCommand(cmd)}`)
					return
				}
				if (isBadCommand(res)) {
					if (commandKeyword(cmd) === 'POWER') this.caps.power = false
					this.log('warn', `The unit does not support @${commandKeyword(cmd)} (BadCommand)`)
				} else if (logResponse) {
					const answer = redactForLog(res.text.replace(/\n/g, ' | ')).slice(0, MAX_LOG_LINE)
					this.log('info', `Response to @${maskCommand(cmd)}: ${answer || '(empty)'}`)
				}
			})
			.catch((err) => {
				this.log('error', `Handling the answer to @${commandKeyword(cmd)} failed: ${err.message}`)
			})
	}

	/** The level a relative fader step should start from: the last level sent, or the reported level. */
	faderBase() {
		return this.faderTarget ?? this.state.fader
	}

	/** Set the master fader (in tenths, already within 0 - 100) from a button. */
	sendFader(tenths) {
		this.faderTarget = tenths
		this.pendingFaderCommands++
		this.sendCommand(`FADER ${tenths}`, {
			onDone: () => {
				this.pendingFaderCommands = Math.max(0, this.pendingFaderCommands - 1)
				if (this.pendingFaderCommands === 0) this.faderTarget = null
			},
		})
	}

	/**
	 * A command typed by the user in the Send Custom Command action. A leading '@' is accepted.
	 * AUTH is refused here: the password belongs in the connection settings, where it is kept as a secret.
	 */
	sendCustomCommand(raw) {
		const cmd = String(raw ?? '')
			.trim()
			.replace(/^@/, '')
		if (cmd.length === 0) return
		if (isAuthCommand(cmd)) {
			this.log('warn', 'Custom commands cannot send AUTH. Set the password in the connection settings instead.')
			return
		}
		this.sendCommand(cmd, { logResponse: true })
	}

	// ------------------------------------------------------------------
	// Receiving
	// ------------------------------------------------------------------

	/**
	 * Responses are ASCII terminated by <CR>. SYSTEM uses <LF> between its fields, so a chunk can hold
	 * several lines. Each chunk answers the command that is currently in flight.
	 */
	processData(data) {
		this.rxBuffer += data

		let idx
		while ((idx = this.rxBuffer.indexOf('\r')) >= 0) {
			const raw = this.rxBuffer.slice(0, idx)
			this.rxBuffer = this.rxBuffer.slice(idx + 1)

			const lines = raw
				.replace(/\0/g, '')
				.split('\n')
				.map((line) => line.trim())
				.filter((line) => line.length > 0)
			const text = lines.join('\n')

			this.log('debug', `RX: ${redactForLog(text.replace(/\n/g, ' | ')).slice(0, MAX_LOG_LINE) || '(empty)'}`)

			const cmd = this.inflight ? this.inflight.cmd : null
			// An answer that arrives after its timeout must not be taken for the answer to the next command
			const belongs = cmd === null || isAnswerTo(cmd, text)
			// Name lists are handed to the code that asked for them.
			if (!(cmd && belongs && isListCommand(cmd))) {
				for (const line of lines) this.parseResponse(line, belongs ? cmd : null)
			}
			if (belongs) {
				this.finishInflight({ text, lines })
			} else {
				this.log('debug', `Late answer, still waiting for the answer to @${commandKeyword(cmd)}`)
			}
		}

		// Data that never ends in a <CR> must not pile up
		if (this.rxBuffer.length > LIMITS.rxBuffer) {
			const dropped = this.rxBuffer.length
			this.rxBuffer = ''
			const now = Date.now()
			if (now - this.lastOverflowWarning >= WARN_THROTTLE_MS) {
				this.log('warn', `Discarded ${dropped} characters from the unit that did not end in a line break`)
				this.lastOverflowWarning = now
			}
		}
	}

	parseResponse(line, cmd) {
		const spaceIdx = line.indexOf(' ')
		const keyword = spaceIdx >= 0 ? line.slice(0, spaceIdx) : line
		const value = spaceIdx >= 0 ? line.slice(spaceIdx + 1).trim() : ''

		switch (keyword) {
			case 'AUTH':
				if (value === 'SECERR') {
					this.log('error', 'Authentication failed (SECERR) - check the password in the module config')
					this.authFailed = true
					this.updateStatus(InstanceStatus.AuthenticationFailure, 'Wrong password')
				} else {
					this.log('info', `Authenticated with ${cleanDeviceText(value, 16)} level`)
					this.updateStatus(InstanceStatus.Ok)
					if (value === 'SETUP' && !this.setupLevelWarned) {
						this.setupLevelWarned = true
						this.log(
							'warn',
							'Authenticated with the Setup password. This module only needs the NetCmd password; ' +
								'with the Setup password a custom command can also change the configuration of the unit.',
						)
					}
				}
				break

			case 'SECERR':
				this.log('warn', 'Command rejected (SECERR) - a password is required. Set it in the module config.')
				this.updateStatus(InstanceStatus.AuthenticationFailure, 'Password required')
				break

			case 'POWER': {
				const state = parseBinary(value)
				if (state !== null) this.setPowerState(state)
				break
			}

			case 'FADER': {
				const lvl = parseInt(value, 10)
				if (!isNaN(lvl) && lvl >= 0 && lvl <= 100) {
					this.state.fader = lvl
					this.setVariableValues({ fader: (lvl / 10).toFixed(1), fader_raw: lvl })
					this.checkFeedbacks('faderLevel', 'levelBar')
				}
				break
			}

			case 'MUTED': {
				const m = parseBinary(value)
				if (m !== null) {
					this.state.muted = m
					this.setVariableValues({ muted: m ? 'Muted' : 'Unmuted' })
					this.checkFeedbacks('muted')
				}
				break
			}

			case 'FORMAT': {
				const format = cleanDeviceText(value, LIMITS.nameLength)
				this.state.format = format
				this.setVariableValues({ format })
				this.checkFeedbacks('format')
				break
			}

			case 'MONITORLEVEL': {
				const lvl = parseInt(value, 10)
				if (!isNaN(lvl) && lvl >= 0 && lvl <= 100) {
					this.state.monitorLevel = lvl
					this.setVariableValues({ monitor_level: lvl })
					this.checkFeedbacks('levelBar')
				}
				break
			}

			case 'MONITORMUTE': {
				const m = parseBinary(value)
				if (m !== null) {
					this.state.monitorMute = m
					this.setVariableValues({ monitor_mute: m ? 'Muted' : 'Unmuted' })
					this.checkFeedbacks('monitorMute')
				}
				break
			}

			case 'HEALTH':
				this.handleHealth(value)
				break

			case 'VER': {
				const version = cleanDeviceText(value, 64)
				this.state.version = version
				this.setVariableValues({ version })
				break
			}

			case 'SERIALNO': {
				const serial = cleanDeviceText(value, 64)
				this.state.serial = serial
				this.setVariableValues({ serial })
				break
			}

			case 'OK':
				// Macro executed, pulse sent, screensaver changed
				break

			case 'ERR':
				this.log('warn', `Device returned error: ${cleanDeviceText(line)}`)
				break

			default:
				// A health answer without its "HEALTH" prefix is still understood
				if (cmd && commandKeyword(cmd) === 'HEALTH') this.handleHealth(line)
				// VERDATE, MAC, BadCommand etc. - the sender of the command deals with it
				break
		}
	}

	// ------------------------------------------------------------------
	// Power state
	// ------------------------------------------------------------------

	isWarmingUp() {
		return Date.now() < this.state.powerWarmupUntil
	}

	setPowerState(power) {
		const previous = this.state.power
		this.state.power = power
		if (power === 0) this.cancelWarmup()
		this.updatePowerVariables()
		if (power === 1 && previous !== 1 && !this.isWarmingUp()) this.ensureNames()
	}

	updatePowerVariables() {
		let label = ''
		if (this.isWarmingUp()) label = 'Starting'
		else if (this.state.power === 1) label = 'On'
		else if (this.state.power === 0) label = 'Standby'
		this.setVariableValues({ power_state: label })
		this.checkFeedbacks('powerState')
	}

	beginWarmup() {
		this.state.powerWarmupUntil = Date.now() + POWER_WARMUP_MS
		if (this.warmupTimer) clearTimeout(this.warmupTimer)
		this.warmupTimer = setTimeout(() => {
			this.warmupTimer = null
			this.state.powerWarmupUntil = 0
			this.updatePowerVariables()
			if (this.state.power === 1) this.ensureNames()
		}, POWER_WARMUP_MS)
		this.updatePowerVariables()
	}

	cancelWarmup() {
		this.state.powerWarmupUntil = 0
		if (this.warmupTimer) {
			clearTimeout(this.warmupTimer)
			this.warmupTimer = null
		}
	}

	/**
	 * Power the unit on or put it in standby. Uses @POWER when the unit supports it,
	 * otherwise the optional fallback macros from the module config.
	 */
	setPower(on) {
		// Try @POWER unless the unit has said it does not know it
		if (this.caps.power !== false) {
			if (on) this.beginWarmup()
			else this.cancelWarmup()
			this.sendCommand(`POWER ${on ? 1 : 0}`)
			return
		}

		const macro = String((on ? this.config.powerOnMacro : this.config.standbyMacro) ?? '')
		if (macro.length > 0) {
			this.sendCommand(`RUNMACRO ${macro}`)
		} else {
			this.log('warn', 'The unit does not support @POWER and no fallback macro is set in the module config')
		}
	}

	// ------------------------------------------------------------------
	// Health
	// ------------------------------------------------------------------

	handleHealth(value) {
		const info = parseHealth(value)
		if (!info) return

		if (info.kind === 'temperature') {
			const [t1, t2, t3] = info.temps
			this.state.temps = { t1, t2, t3 }
			this.setVariableValues({ temp1: t1 ?? '', temp2: t2 ?? '', temp3: t3 ?? '' })
			return
		}

		this.state.boards[info.board] = { present: info.present, ok: info.ok }
		let status = ''
		if (!info.present) status = 'N/A'
		else if (info.ok === true) status = 'OK'
		else if (info.ok === false) status = 'FAULT'
		this.setVariableValues({ [`board_${info.board.toLowerCase()}`]: status })

		if (info.board === 'H336') {
			if (info.phantomOn !== null) {
				this.state.phantomOn = info.phantomOn
				this.setVariableValues({ phantom: info.phantomOn ? 'On' : 'Off' })
				this.checkFeedbacks('phantomOn')
			}
			if (info.cpuOk !== null) {
				this.state.cpuOk = info.cpuOk
				this.setVariableValues({ cpu_power: info.cpuOk ? 'OK' : 'FAULT' })
			}
		}

		this.updateHealthSummary()
	}

	updateHealthSummary() {
		const faults = BOARDS.filter((board) => {
			const entry = this.state.boards[board]
			return entry.present === true && entry.ok === false
		})
		if (this.state.cpuOk === false) faults.push('CPU')

		this.state.powerOk = faults.length === 0
		this.setVariableValues({ power: this.state.powerOk ? 'OK' : 'FAULT', power_faults: faults.join(', ') })
		this.checkFeedbacks('powerFault')
	}
}

runEntrypoint(DatasatAP20Instance, UpgradeScripts)
