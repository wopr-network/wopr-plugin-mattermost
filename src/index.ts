import path from "node:path";
import type { ChannelProvider, ConfigSchema, WOPRPlugin, WOPRPluginContext } from "@wopr-network/plugin-types";
import winston from "winston";
import { MattermostClient } from "./mattermost-client.js";
import type { AgentIdentity, MattermostConfig, MattermostPost, MattermostWsEvent } from "./types.js";

// Module-level state (same pattern as Slack/Telegram plugins)
let ctx: WOPRPluginContext | null = null;
let config: MattermostConfig = {};
let agentIdentity: AgentIdentity = { name: "WOPR", emoji: "eyes" };
let client: MattermostClient | null = null;
let botUserId = "";
let botUsername = "";
let logger: winston.Logger | null = null;
let wsUnsub: (() => void) | null = null;

// Initialize winston logger
function initLogger(): winston.Logger {
	const WOPR_HOME = process.env.WOPR_HOME || path.join(process.env.HOME || "~", ".wopr");
	return winston.createLogger({
		level: "debug",
		format: winston.format.combine(
			winston.format.timestamp(),
			winston.format.errors({ stack: true }),
			winston.format.json(),
		),
		defaultMeta: { service: "wopr-plugin-mattermost" },
		transports: [
			new winston.transports.File({
				filename: path.join(WOPR_HOME, "logs", "mattermost-plugin-error.log"),
				level: "error",
			}),
			new winston.transports.File({
				filename: path.join(WOPR_HOME, "logs", "mattermost-plugin.log"),
				level: "debug",
			}),
			new winston.transports.Console({
				format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
				level: "warn",
			}),
		],
	});
}

// Config schema for WebUI
const configSchema: ConfigSchema = {
	title: "Mattermost Integration",
	description: "Configure Mattermost bot integration",
	fields: [
		{
			name: "serverUrl",
			type: "text",
			label: "Server URL",
			placeholder: "https://mattermost.example.com",
			required: true,
			description: "Your Mattermost server URL (no trailing slash)",
		},
		{
			name: "token",
			type: "password",
			label: "Bot Token (PAT)",
			placeholder: "xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
			description: "Personal Access Token from Mattermost. Preferred auth method.",
		},
		{
			name: "username",
			type: "text",
			label: "Username",
			placeholder: "wopr-bot",
			description: "Alternative auth: bot username (used with password)",
		},
		{
			name: "password",
			type: "password",
			label: "Password",
			placeholder: "...",
			description: "Alternative auth: bot password (used with username)",
		},
		{
			name: "teamName",
			type: "text",
			label: "Team Name",
			placeholder: "my-team",
			description: "Default team to operate in (URL slug, not display name)",
		},
		{
			name: "commandPrefix",
			type: "text",
			label: "Command Prefix",
			placeholder: "!",
			default: "!",
			description: "Prefix for bot commands (e.g. !help)",
		},
		{
			name: "dmPolicy",
			type: "select",
			label: "DM Policy",
			options: [
				{ value: "open", label: "Open (accept all DMs)" },
				{ value: "pairing", label: "Pairing (approve unknown users)" },
				{ value: "closed", label: "Closed (ignore DMs)" },
			],
			default: "pairing",
			description: "How to handle direct messages",
		},
		{
			name: "groupPolicy",
			type: "select",
			label: "Channel Policy",
			options: [
				{ value: "open", label: "Open (respond to mentions)" },
				{ value: "allowlist", label: "Allowlist (configured channels only)" },
				{ value: "disabled", label: "Disabled (ignore channels)" },
			],
			default: "open",
			description: "How to handle channel messages",
		},
		{
			name: "replyToMode",
			type: "select",
			label: "Reply Threading",
			options: [
				{ value: "off", label: "Reply in channel" },
				{ value: "thread", label: "Reply in thread if message is in a thread" },
				{ value: "always-thread", label: "Always reply in thread" },
			],
			default: "thread",
			description: "Control automatic threading of replies",
		},
		{
			name: "enabled",
			type: "checkbox",
			label: "Enabled",
			default: true,
		},
	],
};

// Mattermost message character limit
const MM_MSG_LIMIT = 16383;

// Refresh agent identity
async function refreshIdentity(): Promise<void> {
	if (!ctx) return;
	try {
		const identity = await ctx.getAgentIdentity();
		if (identity) agentIdentity = { ...agentIdentity, ...identity };
	} catch (e) {
		logger?.warn("Failed to refresh identity:", String(e));
	}
}

// Resolve auth token — PAT directly, or login with username/password, or env var
async function resolveClient(): Promise<MattermostClient> {
	if (!config.serverUrl) {
		throw new Error("Mattermost serverUrl is required. Set channels.mattermost.serverUrl");
	}

	if (config.token) {
		return new MattermostClient({ serverUrl: config.serverUrl, token: config.token });
	}

	if (config.username && config.password) {
		const mmClient = new MattermostClient({ serverUrl: config.serverUrl, token: "" });
		await mmClient.login(config.username, config.password);
		return mmClient;
	}

	// Check env vars as fallback
	const envToken = process.env.MATTERMOST_TOKEN || process.env.MATTERMOST_ACCESS_TOKEN;
	if (envToken) {
		return new MattermostClient({ serverUrl: config.serverUrl, token: envToken });
	}

	throw new Error(
		"Mattermost auth required. Set token (PAT) or username+password in config, " + "or set MATTERMOST_TOKEN env var.",
	);
}

// Build session key from channel info
function buildSessionKey(channelId: string, isDM: boolean): string {
	return isDM ? `mattermost-dm-${channelId}` : `mattermost-channel-${channelId}`;
}

// Determine if this is a DM channel (Direct or Group DM)
function isDMChannel(channelType: string): boolean {
	return channelType === "D" || channelType === "G";
}

// Determine if we should respond to this post
function shouldRespond(post: MattermostPost, channelType: string, botMentioned: boolean): boolean {
	// Ignore our own messages
	if (post.user_id === botUserId) return false;

	// Ignore system messages (type is non-empty for system messages)
	if (post.type && post.type !== "") return false;

	const isDM = isDMChannel(channelType);

	if (isDM) {
		const policy = config.dmPolicy || "pairing";
		if (policy === "closed") return false;
		// open and pairing: respond to all DMs
		return true;
	}

	// Channel message
	const policy = config.groupPolicy || "open";
	if (policy === "disabled") return false;

	if (policy === "open") {
		// In open mode, only respond to @mentions
		return botMentioned;
	}

	// Allowlist mode
	if (config.channels) {
		const channelConfig = config.channels[post.channel_id];
		if (!channelConfig || channelConfig.allow === false) return false;
		if (channelConfig.requireMention) return botMentioned;
		return true;
	}

	return false;
}

// Handle a posted WebSocket event
async function handlePostedEvent(event: MattermostWsEvent): Promise<void> {
	if (!ctx || !client) return;

	const postData = event.data?.post;
	if (!postData) return;

	let post: MattermostPost;
	try {
		post = typeof postData === "string" ? JSON.parse(postData) : (postData as MattermostPost);
	} catch {
		return;
	}

	// Get channel type from event data (avoids extra REST call)
	let channelType = (event.data?.channel_type as string) || "";
	if (!channelType) {
		try {
			const channel = await client.getChannel(post.channel_id);
			channelType = channel.type;
		} catch {
			channelType = "O";
		}
	}

	// Check if bot is @mentioned
	const botMentioned = botUsername ? post.message.includes(`@${botUsername}`) : false;

	if (!shouldRespond(post, channelType, botMentioned)) {
		// Log to session for context even if not responding
		const isDM = isDMChannel(channelType);
		const sessionKey = buildSessionKey(post.channel_id, isDM);
		try {
			const user = await client.getUser(post.user_id);
			ctx.logMessage?.(sessionKey, post.message, {
				from: user.username,
				channel: { type: "mattermost", id: post.channel_id },
			});
		} catch {
			// non-critical
		}
		return;
	}

	const isDM = isDMChannel(channelType);
	const sessionKey = buildSessionKey(post.channel_id, isDM);

	let senderUsername: string;
	try {
		const user = await client.getUser(post.user_id);
		senderUsername = user.username;
	} catch {
		senderUsername = post.user_id;
	}

	// Strip @bot mention from message text
	let messageText = post.message;
	if (botUsername) {
		messageText = messageText.replace(new RegExp(`@${botUsername}\\s*`, "gi"), "").trim();
	}

	// Determine threading
	const replyToMode = config.replyToMode || "thread";
	let rootId: string | undefined;
	if (replyToMode === "always-thread") {
		rootId = post.root_id || post.id;
	} else if (replyToMode === "thread" && post.root_id) {
		rootId = post.root_id;
	}
	// "off" — no rootId, reply goes to channel

	// Post initial "Thinking..." message
	let thinkingPost: MattermostPost;
	try {
		thinkingPost = await client.createPost(post.channel_id, "_Thinking..._", rootId);
	} catch (err) {
		logger?.error("Failed to post thinking message:", err);
		return;
	}

	try {
		// Inject message to WOPR AI
		const response = await ctx.inject(sessionKey, messageText, {
			from: senderUsername,
			channel: { type: "mattermost", id: post.channel_id },
		});

		// Truncate if over the Mattermost message limit
		const finalText = response.length > MM_MSG_LIMIT ? `${response.substring(0, MM_MSG_LIMIT - 3)}...` : response;

		await client.updatePost(thinkingPost.id, finalText);
	} catch (error: unknown) {
		logger?.error("Inject failed:", String(error));
		try {
			await client.updatePost(thinkingPost.id, "Error processing your request. Please try again.");
		} catch {
			// non-critical
		}
	}
}

// Handle WebSocket events
async function handleWsEvent(event: MattermostWsEvent): Promise<void> {
	switch (event.event) {
		case "posted":
			await handlePostedEvent(event).catch((err) => {
				logger?.error("Error handling posted event:", err);
			});
			break;
		// Future: handle "typing", "direct_added", channel membership events, etc.
	}
}

// ChannelProvider implementation
const channelProvider: ChannelProvider = {
	id: "mattermost",

	registerCommand() {
		// Slash commands handled via commandPrefix in message text
	},
	unregisterCommand() {},
	getCommands() {
		return [];
	},

	addMessageParser() {},
	removeMessageParser() {},
	getMessageParsers() {
		return [];
	},

	async send(channel: string, content: string): Promise<void> {
		if (!client) throw new Error("Mattermost client not initialized");
		await client.createPost(channel, content);
	},

	getBotUsername(): string {
		return botUsername;
	},
};

// Plugin definition
const plugin: WOPRPlugin = {
	name: "wopr-plugin-mattermost",
	version: "1.0.0",
	description: "Mattermost integration via REST API v4 and WebSocket",

	manifest: {
		name: "wopr-plugin-mattermost",
		version: "1.0.0",
		description: "Mattermost integration via REST API v4 and WebSocket",
		capabilities: ["channel"],
		requires: {
			env: ["MATTERMOST_URL", "MATTERMOST_TOKEN"],
			network: {
				outbound: true,
			},
		},
		provides: {
			capabilities: [
				{
					type: "channel",
					id: "mattermost",
					displayName: "Mattermost",
					tier: "byok",
				},
			],
		},
		icon: "🟦",
		category: "communication",
		tags: ["mattermost", "chat", "self-hosted", "channel"],
		lifecycle: {
			shutdownBehavior: "drain",
			shutdownTimeoutMs: 30_000,
		},
	},

	async init(context: WOPRPluginContext): Promise<void> {
		ctx = context;
		logger = initLogger();

		// Register config schema first
		ctx.registerConfigSchema("wopr-plugin-mattermost", configSchema);

		// Load config — support nested (channels.mattermost) and flat patterns
		type FullConfig = { channels?: { mattermost?: MattermostConfig } } & MattermostConfig;
		const fullConfig = ctx.getConfig<FullConfig>();
		config = fullConfig?.channels?.mattermost || (fullConfig as MattermostConfig) || {};

		// Env var fallback for serverUrl
		if (!config.serverUrl && process.env.MATTERMOST_URL) {
			config.serverUrl = process.env.MATTERMOST_URL;
		}

		// Register channel provider so other plugins can route to Mattermost
		ctx.registerChannelProvider(channelProvider);

		if (config.enabled === false) {
			logger.info("Mattermost plugin disabled in config");
			return;
		}

		// Refresh identity
		await refreshIdentity();

		// Resolve auth and create client
		try {
			client = await resolveClient();
		} catch (err) {
			logger.warn("Mattermost auth not configured:", String(err));
			return;
		}

		// Get bot user info for mention detection and message filtering
		try {
			const me = await client.getMe();
			botUserId = me.id;
			botUsername = me.username;
			logger.info(`Mattermost bot user: @${me.username} (${me.id})`);
		} catch (err) {
			logger.error("Failed to get bot user info:", err);
			throw err;
		}

		// Connect WebSocket and register listener
		wsUnsub = client.addMessageListener(handleWsEvent);
		client.connectWebSocket();
		logger.info("Mattermost WebSocket connected");
	},

	async shutdown(): Promise<void> {
		if (wsUnsub) {
			wsUnsub();
			wsUnsub = null;
		}
		if (client) {
			client.disconnectWebSocket();
			client = null;
		}
		if (ctx) {
			ctx.unregisterChannelProvider("mattermost");
			ctx = null;
		}
		botUserId = "";
		botUsername = "";
		logger?.info("Mattermost plugin stopped");
		logger = null;
	},
};

export default plugin;
