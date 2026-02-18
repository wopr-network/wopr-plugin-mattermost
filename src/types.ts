// Re-export core plugin types (plugin-local definitions — no @wopr-network/plugin-types dependency)

export interface ConfigField {
	name: string;
	type: string;
	label?: string;
	placeholder?: string;
	required?: boolean;
	description?: string;
	hidden?: boolean;
	default?: unknown;
	options?: Array<{ value: string; label: string }>;
}

export interface ConfigSchema {
	title: string;
	description: string;
	fields: ConfigField[];
}

export interface StreamMessage {
	type: "text" | "assistant";
	content: string;
}

export interface ChannelInfo {
	type: string;
	id: string;
	name?: string;
}

export interface InjectOptions {
	silent?: boolean;
	onStream?: (msg: StreamMessage) => void;
	from?: string;
	channel?: ChannelInfo;
	images?: string[];
}

export interface LogMessageOptions {
	from?: string;
	channel?: ChannelInfo;
}

export interface PluginLogger {
	info: (...args: unknown[]) => void;
	warn: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
	debug?: (...args: unknown[]) => void;
}

export interface AgentIdentity {
	name?: string;
	creature?: string;
	vibe?: string;
	emoji?: string;
}

export interface UserProfile {
	name?: string;
	preferredAddress?: string;
	pronouns?: string;
	timezone?: string;
	notes?: string;
}

export interface WOPRPluginContext {
	inject: (session: string, message: string, options?: InjectOptions) => Promise<string>;
	logMessage: (session: string, message: string, options?: LogMessageOptions) => void;
	injectPeer: (peer: string, session: string, message: string) => Promise<string>;
	getIdentity: () => { publicKey: string; shortId: string; encryptPub: string };
	getAgentIdentity: () => AgentIdentity | Promise<AgentIdentity>;
	getUserProfile: () => UserProfile | Promise<UserProfile>;
	getSessions: () => string[];
	getPeers: () => unknown[];
	getConfig: <T = unknown>() => T;
	saveConfig: <T>(config: T) => Promise<void>;
	getMainConfig: (key?: string) => unknown;
	registerConfigSchema: (pluginId: string, schema: ConfigSchema) => void;
	getPluginDir: () => string;
	log: PluginLogger;
}

export interface WOPRPlugin {
	name: string;
	version: string;
	description: string;
	init?: (context: WOPRPluginContext) => Promise<void>;
	shutdown?: () => Promise<void>;
}

// ---- Mattermost-specific types ----

export interface MattermostConfig {
	serverUrl?: string; // e.g. "https://mattermost.example.com"
	token?: string; // Personal Access Token (bot token)
	username?: string; // Alternative: login with username
	password?: string; // Alternative: login with password
	teamName?: string; // Default team name to join
	commandPrefix?: string; // Slash command prefix, default "!"
	dmPolicy?: "open" | "pairing" | "closed";
	groupPolicy?: "allowlist" | "open" | "disabled";
	allowFrom?: string[]; // Allowed user IDs
	channels?: Record<string, { allow?: boolean; requireMention?: boolean }>;
	replyToMode?: "off" | "thread" | "always-thread";
	enabled?: boolean;
}

// WebSocket event from Mattermost
export interface MattermostWsEvent {
	event: string;
	data: Record<string, unknown>;
	broadcast: {
		omit_users?: string[] | null;
		user_id?: string;
		channel_id?: string;
		team_id?: string;
	};
	seq: number;
}

// Mattermost Post object (from REST API / WebSocket)
export interface MattermostPost {
	id: string;
	create_at: number;
	update_at: number;
	delete_at: number;
	user_id: string;
	channel_id: string;
	root_id: string; // empty string if not a thread reply
	message: string;
	type: string;
	props: Record<string, unknown>;
	file_ids?: string[];
	metadata?: unknown;
}

// Mattermost Channel object
export interface MattermostChannel {
	id: string;
	type: "O" | "P" | "D" | "G"; // Open, Private, Direct, Group
	display_name: string;
	name: string;
	team_id: string;
}

// Mattermost User object
export interface MattermostUser {
	id: string;
	username: string;
	first_name: string;
	last_name: string;
	nickname: string;
	email: string;
}
