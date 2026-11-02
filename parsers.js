/**
 * Pure helpers for parsing AP20/AP25 responses (TN-H413 rev D plus the
 * RS20i commands that real AP20/AP25 units also accept), and for keeping what goes
 * to and comes from the unit within safe bounds.
 * Kept free of Companion dependencies so they are easy to reason about and test.
 */

export const BOARDS = ['H331', 'H332', 'H335', 'H336', 'H338']

/** Upper bounds for everything that crosses the wire. */
export const LIMITS = {
	/** Longest command line the module will send (without '@' and <CR>). */
	commandLength: 256,
	/** Longest password accepted from the connection settings. */
	passwordLength: 64,
	/** Unanswered data kept while waiting for a <CR>; beyond this the buffer is dropped. */
	rxBuffer: 16 * 1024,
	/** Most format or macro names taken from a list. */
	names: 100,
	/** Longest single format or macro name. */
	nameLength: 64,
	/** Longest value written into a Companion variable. */
	valueLength: 128,
	/** Button presses that may wait in line; more are dropped. */
	userQueue: 20,
}

/** Commands whose answer is a bare comma separated list without a command echo. */
const LIST_COMMANDS = new Set(['FORMATNAMES', 'MACRONAMES'])

/** Keywords that identify an ordinary, echoed status line (never a name list). */
const STATUS_LINE = /^(FADER|MUTED|MONITORLEVEL|MONITORMUTE|POWER|FORMAT|HEALTH|AUTH|SERIALNO|VER)\s/

// Control characters (C0 range and DEL). <CR> and <LF> would start a new command on the unit.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g
// eslint-disable-next-line no-control-regex
const HAS_CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export function commandKeyword(cmd) {
	return cmd.trim().split(/\s+/)[0].toUpperCase()
}

export function isListCommand(cmd) {
	return LIST_COMMANDS.has(commandKeyword(cmd))
}

export function isAuthCommand(cmd) {
	return commandKeyword(cmd) === 'AUTH'
}

/** The command as it may appear in a log line: the password of an AUTH command is never shown. */
export function maskCommand(cmd) {
	return isAuthCommand(cmd) ? 'AUTH ****' : cmd
}

export function hasControlChars(value) {
	return HAS_CONTROL_CHARS.test(String(value))
}

/**
 * Make a user or variable supplied value safe to put inside a command: control characters
 * (including <CR> and <LF>, which would start a second command) are removed and the length is capped.
 * Spaces are kept as they are, because format and macro names can end in a space.
 */
export function sanitizeArg(value, maxLength = LIMITS.nameLength) {
	return String(value ?? '')
		.replace(CONTROL_CHARS, '')
		.slice(0, maxLength)
}

/** Round and clamp a number. Returns null when the value is not a finite number. */
export function toBoundedInt(value, min, max) {
	const num = typeof value === 'number' ? value : Number(String(value ?? '').trim())
	if (String(value ?? '').trim() === '' || !Number.isFinite(num)) return null
	return Math.min(max, Math.max(min, Math.round(num)))
}

/** Text from the unit as it may be stored in a variable: no control characters, bounded length. */
export function cleanDeviceText(value, maxLength = LIMITS.valueLength) {
	return String(value ?? '')
		.replace(CONTROL_CHARS, '')
		.slice(0, maxLength)
}

/**
 * Hide identifying values in a line that goes to the log: the MAC address in the SYSTEM answer and the
 * serial number. They stay available in the module itself (the serial number as a variable).
 */
export function redactForLog(text) {
	return String(text)
		.replace(/\b(MAC\s+)\S+/gi, '$1***')
		.replace(/\b(SERIALNO\s+)\S+/gi, '$1***')
		.replace(/\b[0-9A-F]{2}(?::[0-9A-F]{2}){5}\b/gi, '***')
}

/**
 * Some units echo the command name in front of the list ("FORMATNAMES A,B,C"), others do not ("A,B,C").
 * An empty list comes back as the bare command name. Remove the echo when it is there.
 */
export function stripListPrefix(cmd, text) {
	const keyword = commandKeyword(cmd)
	const upper = text.toUpperCase()
	if (upper === keyword) return ''
	if (upper.startsWith(`${keyword} `)) return text.slice(keyword.length + 1)
	return text
}

/**
 * "A,B,C" -> ['A', 'B', 'C']. Empty entries (a trailing comma) are dropped.
 * Names are kept exactly as the unit reports them, including a trailing space, because the unit
 * has to recognise the name again when it is sent back. Only leading spaces are removed.
 */
export function parseNameList(text) {
	return text
		.split(',')
		.map((name) => name.replace(/^\s+/, ''))
		.filter((name) => name.trim().length > 0)
}

/**
 * Keep a name list within bounds. Names that are too long or contain control characters are skipped
 * (shortening them would make the unit no longer recognise them), and at most LIMITS.names are kept.
 * Returns the kept names and how many were left out.
 */
export function limitNames(names) {
	const valid = names.filter((name) => name.length <= LIMITS.nameLength && !hasControlChars(name))
	const kept = valid.slice(0, LIMITS.names)
	return { names: kept, skipped: names.length - kept.length }
}

/** Answers that every command can get. */
const GENERIC_ANSWER = /^(BadCommand|SECERR|OK|ERR)\b/i

/** Commands that answer with their own keyword in front of the value (FADER 70, POWER 1, ...). */
const ECHOING_COMMANDS = ['FADER', 'MUTED', 'MONITORLEVEL', 'MONITORMUTE', 'POWER', 'FORMAT', 'SERIALNO']

/**
 * Does this answer belong to this command? Commands are sent one at a time, but an answer that arrives
 * after its timeout would otherwise be taken for the answer to the next command.
 * Commands that are not known here (custom commands) accept any answer.
 */
export function isAnswerTo(cmd, text) {
	if (GENERIC_ANSWER.test(text)) return true

	const keyword = commandKeyword(cmd)
	const upper = text.toUpperCase()

	if (LIST_COMMANDS.has(keyword)) {
		// A list, with or without the command name in front, but not the list or status line of another command
		for (const other of LIST_COMMANDS) {
			if (other !== keyword && (upper === other || upper.startsWith(`${other} `))) return false
		}
		return !STATUS_LINE.test(text)
	}
	if (keyword === 'SYSTEM') return /^VER\b/i.test(text)
	if (keyword === 'HEALTH') return /^(HEALTH|TEMPERATURE|H\d{3}VOLTS)\b/i.test(text)
	if (keyword === 'AUTH') return /^AUTH\b/i.test(text)
	if (ECHOING_COMMANDS.includes(keyword)) return new RegExp(`^${keyword}(\\s|$)`, 'i').test(text)
	return true
}

/**
 * What a *Names answer tells us:
 *   'list'        the unit sent a list (possibly empty)
 *   'unsupported' the unit does not know the command (BadCommand) - final
 *   'unknown'     no answer, an error, or an answer that does not fit - try again later
 */
export function classifyListResponse(res, cmd) {
	if (res === null || res === undefined) return 'unknown'
	if (/^BadCommand\b/i.test(res.text)) return 'unsupported'
	if (/^(SECERR|ERR)\b/i.test(res.text)) return 'unknown'
	if (!isAnswerTo(cmd, res.text)) return 'unknown'
	return 'list'
}

export function isBadCommand(res) {
	return res !== null && res !== undefined && /^BadCommand/i.test(res.text)
}

/** "1" -> 1, "0" -> 0, anything else -> null */
export function parseBinary(value) {
	const trimmed = String(value).trim()
	if (trimmed === '1') return 1
	if (trimmed === '0') return 0
	return null
}

/** A temperature as the unit reports it ("41"), or null when it is not a plain number. */
function parseTemperature(value) {
	const trimmed = String(value ?? '').trim()
	return /^-?\d{1,3}(\.\d{1,2})?$/.test(trimmed) ? trimmed : null
}

/**
 * Parse the part of a HEALTH response after the "HEALTH " prefix.
 *   "TEMPERATURE 34,29,25"
 *   "H331VOLTS 1,3.18,4.99,15.0,-15.0-,-5.0"
 *   "H332VOLTS NA"
 *   "H336VOLTS 1,3.39,5.10,15.0,-14.4,0.0,1"   (... <48V phantom>,<vcpu>)
 * Returns null for anything that is not understood.
 */
export function parseHealth(value) {
	const match = /^(\S+)\s+(.*)$/.exec(value.trim())
	if (!match) return null

	const sub = match[1].toUpperCase()
	const rest = match[2].trim()

	if (sub === 'TEMPERATURE') {
		const temps = rest.split(',').slice(0, 3).map(parseTemperature)
		while (temps.length < 3) temps.push(null)
		return { kind: 'temperature', temps }
	}

	const volts = /^(H\d{3})VOLTS$/.exec(sub)
	if (!volts || !BOARDS.includes(volts[1])) return null

	const board = volts[1]
	if (rest.toUpperCase() === 'NA') {
		return { kind: 'volts', board, present: false, ok: null, phantomOn: null, cpuOk: null }
	}

	const fields = rest.split(',').map((f) => f.trim())
	const vok = parseBinary(fields[0])
	const result = {
		kind: 'volts',
		board,
		present: true,
		ok: vok === null ? null : vok === 1,
		phantomOn: null,
		cpuOk: null,
	}

	if (board === 'H336') {
		// <vok>,<ref>,<+5V>,<+15V>,<-15V>,<48V>,<vcpu>
		const phantom = parseFloat(fields[5])
		if (!Number.isNaN(phantom)) result.phantomOn = phantom > 1
		const cpu = parseBinary(fields[6] ?? '')
		if (cpu !== null) result.cpuOk = cpu === 1
	}

	return result
}
