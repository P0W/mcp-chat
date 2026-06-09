export type LlmProtocol = "openai" | "anthropic";

export interface ProviderConfig {
  id: string;
  name: string;
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  extraHeaders?: Record<string, string>;
}

export type McpAuthMode = "none" | "bearer" | "oauth";

export interface OAuthState {
  clientId?: string;
  clientSecret?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

export interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  auth: McpAuthMode;
  bearer?: string;
  oauth?: OAuthState;
  enabled: boolean;
}

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  createdAt: number;
}

export interface Chat {
  id: string;
  title: string;
  providerId: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface McpTool {
  serverId: string;
  serverName: string;
  name: string;
  description?: string;
  inputSchema: unknown;
}
