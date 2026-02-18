import WebSocket from "ws";
import type { MattermostChannel, MattermostPost, MattermostUser, MattermostWsEvent } from "./types.js";

export interface MattermostClientOptions {
	serverUrl: string; // Base URL, no trailing slash
	token: string; // Bearer token (PAT or session token)
}

export type WsEventHandler = (event: MattermostWsEvent) => void;

export class MattermostClient {
	private baseUrl: string;
	private token: string;
	private ws: InstanceType<typeof WebSocket> | null = null;
	private wsListeners: WsEventHandler[] = [];
	private reconnectTimer: NodeJS.Timeout | null = null;
	private reconnectAttempts = 0;
	private readonly maxReconnectAttempts = 10;
	private readonly reconnectBaseDelay = 1000; // ms, exponential backoff
	private shouldReconnect = true;

	constructor(opts: MattermostClientOptions) {
		this.baseUrl = opts.serverUrl.replace(/\/+$/, "");
		this.token = opts.token;
	}

	// --- REST API helpers ---

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const url = `${this.baseUrl}/api/v4${path}`;
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.token}`,
			"Content-Type": "application/json",
		};
		const res = await fetch(url, {
			method,
			headers,
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Mattermost API ${method} ${path} failed (${res.status}): ${text}`);
		}
		return res.json() as Promise<T>;
	}

	// --- Auth ---

	/** Login with username/password, returns a session token. Stores it internally. */
	async login(username: string, password: string): Promise<string> {
		const url = `${this.baseUrl}/api/v4/users/login`;
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ login_id: username, password }),
		});
		if (!res.ok) {
			throw new Error(`Login failed (${res.status}): ${await res.text()}`);
		}
		const sessionToken = res.headers.get("token");
		if (!sessionToken) throw new Error("No token in login response headers");
		this.token = sessionToken;
		return sessionToken;
	}

	// --- Users ---

	async getMe(): Promise<MattermostUser> {
		return this.request<MattermostUser>("GET", "/users/me");
	}

	async getUser(userId: string): Promise<MattermostUser> {
		return this.request<MattermostUser>("GET", `/users/${userId}`);
	}

	// --- Channels ---

	async getChannel(channelId: string): Promise<MattermostChannel> {
		return this.request<MattermostChannel>("GET", `/channels/${channelId}`);
	}

	async getDirectChannel(userId1: string, userId2: string): Promise<MattermostChannel> {
		return this.request<MattermostChannel>("POST", "/channels/direct", [userId1, userId2]);
	}

	// --- Posts ---

	async createPost(channelId: string, message: string, rootId?: string, fileIds?: string[]): Promise<MattermostPost> {
		const body: Record<string, unknown> = { channel_id: channelId, message };
		if (rootId) body.root_id = rootId;
		if (fileIds?.length) body.file_ids = fileIds;
		return this.request<MattermostPost>("POST", "/posts", body);
	}

	async updatePost(postId: string, message: string): Promise<MattermostPost> {
		return this.request<MattermostPost>("PUT", `/posts/${postId}`, {
			id: postId,
			message,
		});
	}

	async getPost(postId: string): Promise<MattermostPost> {
		return this.request<MattermostPost>("GET", `/posts/${postId}`);
	}

	// --- Files ---

	async uploadFile(channelId: string, filename: string, data: Buffer): Promise<{ file_infos: Array<{ id: string }> }> {
		const url = `${this.baseUrl}/api/v4/files`;
		const formData = new FormData();
		formData.append("channel_id", channelId);
		formData.append("files", new Blob([data]), filename);
		const res = await fetch(url, {
			method: "POST",
			headers: { Authorization: `Bearer ${this.token}` },
			body: formData,
		});
		if (!res.ok) {
			throw new Error(`File upload failed (${res.status}): ${await res.text()}`);
		}
		return res.json() as Promise<{ file_infos: Array<{ id: string }> }>;
	}

	// --- Slash Commands (custom, via REST) ---

	async createCommand(
		teamId: string,
		command: {
			trigger: string;
			url: string;
			method: "P" | "G";
			display_name: string;
			description: string;
			auto_complete: boolean;
			auto_complete_hint?: string;
		},
	): Promise<unknown> {
		return this.request("POST", "/commands", { team_id: teamId, ...command });
	}

	// --- Teams ---

	async getTeamByName(teamName: string): Promise<{ id: string; name: string; display_name: string }> {
		return this.request("GET", `/teams/name/${teamName}`);
	}

	// --- WebSocket ---

	addMessageListener(handler: WsEventHandler): () => void {
		this.wsListeners.push(handler);
		return () => {
			this.wsListeners = this.wsListeners.filter((h) => h !== handler);
		};
	}

	connectWebSocket(): void {
		this.shouldReconnect = true;
		this.doConnect();
	}

	private doConnect(): void {
		const wsUrl = this.baseUrl.replace(/^http/, "ws") + "/api/v4/websocket";
		this.ws = new WebSocket(wsUrl);

		this.ws.on("open", () => {
			// Authenticate via authentication_challenge (Mattermost WS standard)
			this.ws?.send(
				JSON.stringify({
					seq: 1,
					action: "authentication_challenge",
					data: { token: this.token },
				}),
			);
			this.reconnectAttempts = 0;
		});

		this.ws.on("message", (raw: WebSocket.RawData) => {
			try {
				const event: MattermostWsEvent = JSON.parse(raw.toString());
				for (const handler of this.wsListeners) {
					handler(event);
				}
			} catch {
				// ignore parse errors
			}
		});

		this.ws.on("close", () => {
			if (this.shouldReconnect) {
				this.scheduleReconnect();
			}
		});

		this.ws.on("error", () => {
			// close event will fire after error, triggering reconnect
		});
	}

	private scheduleReconnect(): void {
		if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
		const delay = this.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts);
		this.reconnectAttempts++;
		this.reconnectTimer = setTimeout(() => this.doConnect(), delay);
	}

	disconnectWebSocket(): void {
		this.shouldReconnect = false;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
	}
}
