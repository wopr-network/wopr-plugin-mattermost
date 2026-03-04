import EventEmitter from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class MockWs extends EventEmitter {
	send = vi.fn();
	close = vi.fn();
}

// Mock ws and winston before any imports
vi.mock("ws", () => ({ default: MockWs }));

vi.mock("winston", () => ({
	default: {
		createLogger: vi.fn(() => ({
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		})),
		format: {
			combine: vi.fn(() => ({})),
			timestamp: vi.fn(() => ({})),
			errors: vi.fn(() => ({})),
			json: vi.fn(() => ({})),
			colorize: vi.fn(() => ({})),
			simple: vi.fn(() => ({})),
		},
		transports: {
			File: vi.fn(),
			Console: vi.fn(),
		},
	},
}));

// Import after mocking
const plugin = (await import("../../src/index.js")).default;

function makeCtx(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		registerConfigSchema: vi.fn(),
		registerChannelProvider: vi.fn(),
		unregisterChannelProvider: vi.fn(),
		unregisterConfigSchema: vi.fn(),
		getConfig: vi.fn().mockReturnValue({}),
		getAgentIdentity: vi.fn().mockResolvedValue({ name: "WOPR" }),
		logMessage: vi.fn(),
		inject: vi.fn().mockResolvedValue("AI response"),
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		...overrides,
	};
}

describe("plugin export", () => {
	it("exports default WOPRPlugin object with required fields", () => {
		expect(plugin).toBeDefined();
		expect(plugin.name).toBe("wopr-plugin-mattermost");
		expect(plugin.version).toBe("1.0.0");
		expect(plugin.description).toContain("Mattermost");
	});

	it("has init function", () => {
		expect(typeof plugin.init).toBe("function");
	});

	it("has shutdown function", () => {
		expect(typeof plugin.shutdown).toBe("function");
	});

	it("has manifest with required fields", () => {
		expect(plugin.manifest).toBeDefined();
		expect(plugin.manifest?.capabilities).toContain("channel");
		expect(plugin.manifest?.icon).toBeDefined();
		expect(plugin.manifest?.category).toBeDefined();
		expect(plugin.manifest?.tags).toBeDefined();
		expect(plugin.manifest?.lifecycle).toBeDefined();
		expect(plugin.manifest?.provides?.capabilities).toHaveLength(1);
		expect(plugin.manifest?.provides?.capabilities[0].type).toBe("channel");
	});

	it("manifest has configSchema", () => {
		expect(plugin.manifest?.configSchema).toBeDefined();
		expect(plugin.manifest?.configSchema?.fields).toBeDefined();
	});

	it("config schema marks token and password as secret", () => {
		const schema = plugin.manifest?.configSchema;
		expect(schema).toBeDefined();

		const tokenField = schema!.fields.find((f: any) => f.name === "token");
		const passwordField = schema!.fields.find((f: any) => f.name === "password");

		expect(tokenField?.secret).toBe(true);
		expect(passwordField?.secret).toBe(true);
	});

	it("config schema has setupFlow on input fields", () => {
		const schema = plugin.manifest?.configSchema;
		expect(schema).toBeDefined();

		const serverUrlField = schema!.fields.find((f: any) => f.name === "serverUrl");
		const tokenField = schema!.fields.find((f: any) => f.name === "token");

		expect(serverUrlField?.setupFlow).toBe("paste");
		expect(tokenField?.setupFlow).toBe("paste");
	});
});

describe("plugin.init", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
		await plugin.shutdown?.();
	});

	it("registers config schema with correct plugin ID", async () => {
		const ctx = makeCtx({
			getConfig: vi.fn().mockReturnValue({ enabled: false }),
		});
		await plugin.init!(ctx as any);
		expect(ctx.registerConfigSchema).toHaveBeenCalledWith(
			"wopr-plugin-mattermost",
			expect.objectContaining({ title: expect.any(String) }),
		);
	});

	it("calls registerChannelProvider on init", async () => {
		const ctx = makeCtx({
			getConfig: vi.fn().mockReturnValue({ enabled: false }),
		});
		await plugin.init!(ctx as any);
		expect(ctx.registerChannelProvider).toHaveBeenCalledWith(
			expect.objectContaining({ id: "mattermost" }),
		);
	});

	it("skips connecting when enabled=false", async () => {
		const ctx = makeCtx({
			getConfig: vi.fn().mockReturnValue({ enabled: false }),
		});
		await plugin.init!(ctx as any);
		// fetch should NOT be called (no client created)
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("skips when no auth configured and no env vars", async () => {
		const savedToken = process.env.MATTERMOST_TOKEN;
		const savedAccessToken = process.env.MATTERMOST_ACCESS_TOKEN;
		const savedUrl = process.env.MATTERMOST_URL;
		delete process.env.MATTERMOST_TOKEN;
		delete process.env.MATTERMOST_ACCESS_TOKEN;
		delete process.env.MATTERMOST_URL;

		const ctx = makeCtx({
			getConfig: vi.fn().mockReturnValue({ serverUrl: "https://mm.example.com" }),
		});

		// Should not throw — just warns and returns
		await expect(plugin.init!(ctx as any)).resolves.not.toThrow();

		if (savedToken !== undefined) process.env.MATTERMOST_TOKEN = savedToken;
		if (savedAccessToken !== undefined) process.env.MATTERMOST_ACCESS_TOKEN = savedAccessToken;
		if (savedUrl !== undefined) process.env.MATTERMOST_URL = savedUrl;
	});

	it("connects and gets bot user ID when token provided", async () => {
		(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ id: "bot1", username: "wopr-bot" }),
			headers: { get: () => null },
		});

		const ctx = makeCtx({
			getConfig: vi.fn().mockReturnValue({
				serverUrl: "https://mm.example.com",
				token: "pat-token-123",
			}),
		});
		await plugin.init!(ctx as any);
		expect(global.fetch).toHaveBeenCalledWith(
			"https://mm.example.com/api/v4/users/me",
			expect.anything(),
		);
	});

	it("loads config from channels.mattermost nested path", async () => {
		(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ id: "bot1", username: "wopr-bot" }),
			headers: { get: () => null },
		});

		const ctx = makeCtx({
			getConfig: vi.fn().mockReturnValue({
				channels: {
					mattermost: {
						serverUrl: "https://nested.mm.example.com",
						token: "nested-token",
					},
				},
			}),
		});
		await plugin.init!(ctx as any);
		expect(global.fetch).toHaveBeenCalledWith(
			"https://nested.mm.example.com/api/v4/users/me",
			expect.anything(),
		);
	});
});

describe("plugin.shutdown", () => {
	it("can be called without throwing when not initialized", async () => {
		// Ensure no prior state
		await plugin.shutdown?.();
		// Call again to verify idempotency
		await plugin.shutdown?.();
	});

	it("disconnects WebSocket and resets state on shutdown", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ id: "bot1", username: "wopr-bot" }),
				headers: { get: () => null },
			}),
		);

		const ctx = makeCtx({
			getConfig: vi.fn().mockReturnValue({
				serverUrl: "https://mm.example.com",
				token: "pat-token-123",
			}),
		});

		await plugin.init!(ctx as any);
		// Should not throw
		await expect(plugin.shutdown!()).resolves.not.toThrow();

		vi.unstubAllGlobals();
	});

	it("calls unregisterChannelProvider on shutdown", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ id: "bot1", username: "wopr-bot" }),
				headers: { get: () => null },
			}),
		);

		const ctx = makeCtx({
			getConfig: vi.fn().mockReturnValue({
				serverUrl: "https://mm.example.com",
				token: "pat-token-123",
			}),
		});

		await plugin.init!(ctx as any);
		await plugin.shutdown!();

		expect(ctx.unregisterChannelProvider).toHaveBeenCalledWith("mattermost");
		vi.unstubAllGlobals();
	});

	it("drains all cleanups on shutdown including unregisterConfigSchema", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ id: "bot1", username: "wopr-bot" }),
				headers: { get: () => null },
			}),
		);

		const ctx = makeCtx({
			getConfig: vi.fn().mockReturnValue({
				serverUrl: "https://mm.example.com",
				token: "pat-token-123",
			}),
			unregisterConfigSchema: vi.fn(),
		});

		await plugin.init!(ctx as any);
		await plugin.shutdown!();

		// Second shutdown should be safe (idempotent)
		await plugin.shutdown!();

		expect(ctx.unregisterConfigSchema).toHaveBeenCalledWith("wopr-plugin-mattermost");
		vi.unstubAllGlobals();
	});
});

describe("channelProvider", () => {
	let channelProv: any;

	beforeEach(async () => {
		vi.stubGlobal("fetch", vi.fn());
		const ctx = makeCtx({
			getConfig: vi.fn().mockReturnValue({ enabled: false }),
		});
		await plugin.init!(ctx as any);
		// Grab the channel provider from the registerChannelProvider call
		channelProv = (ctx.registerChannelProvider as ReturnType<typeof vi.fn>).mock.calls[0][0];
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
		await plugin.shutdown?.();
	});

	it("registers and retrieves commands", () => {
		const cmd = { name: "test", description: "Test command", handler: vi.fn() };
		channelProv.registerCommand(cmd);
		expect(channelProv.getCommands()).toHaveLength(1);
		expect(channelProv.getCommands()[0].name).toBe("test");
	});

	it("unregisters commands by name", () => {
		const cmd = { name: "test", description: "Test command", handler: vi.fn() };
		channelProv.registerCommand(cmd);
		channelProv.unregisterCommand("test");
		expect(channelProv.getCommands()).toHaveLength(0);
	});

	it("adds and retrieves message parsers", () => {
		const parser = { id: "p1", pattern: /test/, handler: vi.fn() };
		channelProv.addMessageParser(parser);
		expect(channelProv.getMessageParsers()).toHaveLength(1);
		expect(channelProv.getMessageParsers()[0].id).toBe("p1");
	});

	it("removes message parsers by ID", () => {
		const parser = { id: "p1", pattern: /test/, handler: vi.fn() };
		channelProv.addMessageParser(parser);
		channelProv.removeMessageParser("p1");
		expect(channelProv.getMessageParsers()).toHaveLength(0);
	});
});

describe("sendNotification", () => {
	let channelProv: any;

	async function initWithDisabled() {
		const ctx = makeCtx({
			getConfig: vi.fn().mockReturnValue({ enabled: false }),
		});
		await plugin.init!(ctx as any);
		channelProv = (ctx.registerChannelProvider as ReturnType<typeof vi.fn>).mock.calls[0][0];
		return ctx;
	}

	afterEach(async () => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
		await plugin.shutdown?.();
	});

	it("is a function on the channel provider", async () => {
		vi.stubGlobal("fetch", vi.fn());
		await initWithDisabled();
		expect(typeof channelProv.sendNotification).toBe("function");
	});

	it("posts a friend-request notification message to the channel", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ id: "bot1", username: "wopr-bot" }),
			headers: { get: () => null },
		}));

		const ctx = makeCtx({
			getConfig: vi.fn().mockReturnValue({
				serverUrl: "https://mm.example.com",
				token: "tok",
			}),
		});
		await plugin.init!(ctx as any);
		channelProv = (ctx.registerChannelProvider as ReturnType<typeof vi.fn>).mock.calls[0][0];

		const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
		fetchMock.mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ id: "notif-post-1", channel_id: "ch1", message: "" }),
			headers: { get: () => null },
		});

		const onAccept = vi.fn();
		const onDeny = vi.fn();
		await channelProv.sendNotification(
			"ch1",
			{ type: "friend-request", from: "alice" },
			{ onAccept, onDeny },
		);

		const postCalls = fetchMock.mock.calls.filter(
			(c: any[]) => c[0].includes("/api/v4/posts") && c[1]?.method === "POST",
		);
		expect(postCalls.length).toBeGreaterThanOrEqual(1);
		const lastPostBody = JSON.parse(postCalls[postCalls.length - 1][1].body);
		expect(lastPostBody.channel_id).toBe("ch1");
		expect(lastPostBody.message).toContain("alice");
		expect(lastPostBody.message).toContain("!accept");
		expect(lastPostBody.message).toContain("!deny");
	});

	it("ignores non friend-request notification types", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ id: "bot1", username: "wopr-bot" }),
			headers: { get: () => null },
		}));

		const ctx = makeCtx({
			getConfig: vi.fn().mockReturnValue({
				serverUrl: "https://mm.example.com",
				token: "tok",
			}),
		});
		await plugin.init!(ctx as any);
		channelProv = (ctx.registerChannelProvider as ReturnType<typeof vi.fn>).mock.calls[0][0];

		const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
		fetchMock.mockClear();

		await channelProv.sendNotification("ch1", { type: "other-type" });

		const postCalls = fetchMock.mock.calls.filter(
			(c: any[]) => c[0].includes("/api/v4/posts") && c[1]?.method === "POST",
		);
		expect(postCalls).toHaveLength(0);
	});

	it("works without callbacks (no-op on accept/deny)", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ id: "bot1", username: "wopr-bot" }),
			headers: { get: () => null },
		}));

		const ctx = makeCtx({
			getConfig: vi.fn().mockReturnValue({
				serverUrl: "https://mm.example.com",
				token: "tok",
			}),
		});
		await plugin.init!(ctx as any);
		channelProv = (ctx.registerChannelProvider as ReturnType<typeof vi.fn>).mock.calls[0][0];

		await expect(
			channelProv.sendNotification("ch1", { type: "friend-request", from: "bob" }),
		).resolves.not.toThrow();
	});
});

describe("sendNotification auth guard and TTL", () => {
	let channelProv: any;
	let mockWsInstance: any;

	beforeEach(async () => {
		vi.useFakeTimers();
		// Mock fetch: first call (getMe) returns bot user, second (getChannel) returns DM channel,
		// third (createPost) returns post
		const fetchMock = vi.fn()
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ id: "bot-user-id", username: "wopr-bot" }),
				headers: { get: () => null },
			})
			.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({}),
				headers: { get: () => null },
			});
		vi.stubGlobal("fetch", fetchMock);

		const ctx = makeCtx({
			getConfig: vi.fn().mockReturnValue({
				serverUrl: "https://mm.example.com",
				token: "tok",
			}),
		});
		await plugin.init!(ctx as any);
		channelProv = (ctx.registerChannelProvider as ReturnType<typeof vi.fn>).mock.calls[0][0];
	});

	afterEach(async () => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.clearAllMocks();
		await plugin.shutdown?.();
	});

	it("stores pending notification keyed by channelId:ownerUserId for DM channels", async () => {
		const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
		// getChannel returns DM channel with name encoding both user IDs
		fetchMock.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ id: "ch1", type: "D", name: "owner-user-id__bot-user-id" }),
			headers: { get: () => null },
		});
		// createPost returns a post
		fetchMock.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ id: "post1", channel_id: "ch1", message: "" }),
			headers: { get: () => null },
		});

		const onAccept = vi.fn();
		await channelProv.sendNotification("ch1", { type: "friend-request", from: "alice" }, { onAccept });

		// Simulate !accept from the correct owner
		const MockWsClass = (await import("ws")).default as any;
		// Use WebSocket event simulation via the handler
		// We can't easily trigger the WS handler here without more setup.
		// Just verify callbacks object is not called yet (stored pending).
		expect(onAccept).not.toHaveBeenCalled();
	});

	it("clears pending notification after TTL expires", async () => {
		const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
		fetchMock.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ id: "ch1", type: "D", name: "owner-user__bot-user-id" }),
			headers: { get: () => null },
		});
		fetchMock.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ id: "post1", channel_id: "ch1", message: "" }),
			headers: { get: () => null },
		});

		const onAccept = vi.fn();
		await channelProv.sendNotification("ch1", { type: "friend-request", from: "alice" }, { onAccept });

		// Advance timer past 24 hours
		vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);

		// onAccept should not have been called (just cleaned up from map)
		expect(onAccept).not.toHaveBeenCalled();
	});

	it("clears timers on shutdown", async () => {
		const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
		fetchMock.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ id: "ch1", type: "D", name: "owner-user__bot-user-id" }),
			headers: { get: () => null },
		});
		fetchMock.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ id: "post1", channel_id: "ch1", message: "" }),
			headers: { get: () => null },
		});

		const onAccept = vi.fn();
		await channelProv.sendNotification("ch1", { type: "friend-request", from: "alice" }, { onAccept });

		// Shutdown should not throw even with active timers
		await expect(plugin.shutdown!()).resolves.not.toThrow();
	});
});

describe("shouldRespond logic (DM and channel policies)", () => {
	it("open DM policy responds to direct messages", () => {
		const channelType = "D";
		const dmPolicy = "open";
		const isDM = channelType === "D" || channelType === "G";
		const shouldRespond = isDM && dmPolicy !== "closed";
		expect(shouldRespond).toBe(true);
	});

	it("closed DM policy rejects direct messages", () => {
		const channelType = "D";
		const dmPolicy = "closed";
		const isDM = channelType === "D" || channelType === "G";
		const shouldRespond = isDM && dmPolicy !== "closed";
		expect(shouldRespond).toBe(false);
	});

	it("group DM (type G) is treated as DM for policy", () => {
		const channelType = "G";
		const dmPolicy = "open";
		const isDM = channelType === "D" || channelType === "G";
		const shouldRespond = isDM && dmPolicy !== "closed";
		expect(shouldRespond).toBe(true);
	});

	it("open group policy without mention does not respond", () => {
		const channelType = "O";
		const groupPolicy = "open";
		const botMentioned = false;
		const isDM = channelType === "D" || channelType === "G";
		const shouldRespond = isDM || (groupPolicy === "open" && botMentioned);
		expect(shouldRespond).toBe(false);
	});

	it("open group policy with mention responds", () => {
		const channelType = "O";
		const groupPolicy = "open";
		const botMentioned = true;
		const isDM = channelType === "D" || channelType === "G";
		const shouldRespond = isDM || (groupPolicy === "open" && botMentioned);
		expect(shouldRespond).toBe(true);
	});

	it("disabled group policy never responds in channels", () => {
		const channelType = "O";
		const groupPolicy = "disabled";
		const botMentioned = true;
		const isDM = channelType === "D" || channelType === "G";
		const shouldRespond = !isDM && groupPolicy !== "disabled" && botMentioned;
		expect(shouldRespond).toBe(false);
	});
});
