import * as fs from "fs/promises"

import { safeWriteJson } from "../../utils/safeWriteJson"

import { aiClusterMcpUrl } from "./client"

/**
 * Register the cluster's own MCP server so its tools are real tools.
 *
 * Before this, the only way an agent could reach DocForge was a curl command
 * embedded in the cluster's system prompt — the model had to reproduce it, in
 * the right shell, with valid JSON inside single quotes, and any slip produced
 * a file that looked like a document and was not. The cluster serves MCP on the
 * same port as everything else, so the address is already configured; all that
 * is missing is the entry telling this extension to connect.
 *
 * The entry is written into the ordinary global MCP settings file rather than
 * injected into the hub, so it behaves like any other server: visible in the
 * MCP list, disableable, and removable by hand.
 */

export const AI_CLUSTER_MCP_SERVER_NAME = "ai-cluster"

type McpSettings = {
	mcpServers?: Record<string, Record<string, unknown>>
}

const readSettings = async (settingsPath: string): Promise<McpSettings> => {
	try {
		const raw = await fs.readFile(settingsPath, "utf-8")
		const parsed = JSON.parse(raw)
		return parsed && typeof parsed === "object" ? (parsed as McpSettings) : {}
	} catch {
		// Missing or unparsable: the hub rewrites a broken file anyway, and
		// refusing to register because of it would be a worse failure.
		return {}
	}
}

/**
 * Add or update the cluster entry. Returns true when the file changed — the
 * hub watches it, so writing an identical file would reconnect every server
 * for nothing.
 */
export async function registerClusterMcpServer(settingsPath: string, baseUrl: string): Promise<boolean> {
	const settings = await readSettings(settingsPath)
	const servers = settings.mcpServers ?? {}
	const existing = servers[AI_CLUSTER_MCP_SERVER_NAME]

	const entry = {
		// Preserve whatever the user changed by hand (disabled, alwaysAllow,
		// timeouts): this rewrites the address, not their preferences.
		...(existing ?? {}),
		type: "streamable-http",
		url: aiClusterMcpUrl(baseUrl),
	}

	if (existing && JSON.stringify(existing) === JSON.stringify(entry)) {
		return false
	}

	await safeWriteJson(settingsPath, { ...settings, mcpServers: { ...servers, [AI_CLUSTER_MCP_SERVER_NAME]: entry } })
	return true
}

/** Remove the entry again — used when the user turns the integration off. */
export async function unregisterClusterMcpServer(settingsPath: string): Promise<boolean> {
	const settings = await readSettings(settingsPath)
	const servers = settings.mcpServers ?? {}

	if (!(AI_CLUSTER_MCP_SERVER_NAME in servers)) {
		return false
	}

	const { [AI_CLUSTER_MCP_SERVER_NAME]: _removed, ...rest } = servers
	await safeWriteJson(settingsPath, { ...settings, mcpServers: rest })
	return true
}
