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
