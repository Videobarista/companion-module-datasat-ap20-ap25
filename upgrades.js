// Upgrade scripts run once per connection when a user updates from an older version of this module.
// Companion remembers which ones have run, so each script must stay in this list, in this order.

/**
 * 2.2.0: the password moves from the connection config (which Companion sends to the web interface)
 * to the secrets store. An existing password is copied over and removed from the config.
 */
export function movePasswordToSecrets(_context, props) {
	const config = props.config
	if (!config || !Object.prototype.hasOwnProperty.call(config, 'password')) {
		return { updatedConfig: null, updatedSecrets: null, updatedActions: [], updatedFeedbacks: [] }
	}

	const { password, ...rest } = config
	const secrets = { ...(props.secrets ?? {}) }
	if (typeof password === 'string' && password.length > 0 && !secrets.password) {
		secrets.password = password
	}

	return { updatedConfig: rest, updatedSecrets: secrets, updatedActions: [], updatedFeedbacks: [] }
}

export const UpgradeScripts = [movePasswordToSecrets]
