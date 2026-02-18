// Mattermost-specific types.
// Core plugin types (WOPRPlugin, WOPRPluginContext, ChannelProvider, ConfigSchema, etc.)
// are imported from "@wopr-network/plugin-types" in index.ts.

export interface AgentIdentity {
	name?: string;
	creature?: string;
	vibe?: string;
	emoji?: string;
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
