import type { ProviderSettings } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types"

import type { ClineProvider } from "../../core/webview/ClineProvider"

import { type ClusterCredentials } from "./client"
import { clearClusterSkills, syncClusterSkills, type ClusterSkillsSyncResult } from "./skillsSync"
import { registerClusterMcpServer, unregisterClusterMcpServer } from "./mcpRegistration"

export { AI_CLUSTER_MCP_SERVER_NAME, registerClusterMcpServer, unregisterClusterMcpServer } from "./mcpRegistration"
export { CLUSTER_SKILLS_DIRNAME, getClusterSkillsDirectory, syncClusterSkills, clearClusterSkills } from "./skillsSync"
export { aiClusterMcpUrl, fetchClusterSkills } from "./client"

/**
 * Everything about an AI Cluster that is not inference.
 *
 * The provider only knows how to talk to /v1/chat/completions. The same host
 * also has the skills the cluster expects its models to follow and an MCP
 * server exposing its document, knowledge-base and status tools — and both are
 * useless unless something here goes and connects them. This runs on
 * activation and whenever the provider settings change, so pointing the
 * extension at a cluster is the only step a user performs.
 */

export const clusterCredentials = (settings: ProviderSettings | undefined): ClusterCredentials | undefined => {
	if (!settings || settings.apiProvider !== providerIdentifiers.aiCluster) {
		return undefined
	}
	const baseUrl = settings.aiClusterBaseUrl?.trim()
	return baseUrl ? { baseUrl, apiKey: settings.aiClusterApiKey } : undefined
}

/**
 * Where to send a document, for a profile that is not the AI Cluster one.
 *
 * That provider was added late. Anyone who set this cluster up before it
 * existed — which the cluster's own README told people to do for months — has
 * an "OpenAI Compatible" profile pointing at the same address, and everything
 * else works: same host, same port, same API. Refusing to build a document
 * there because a dropdown says something else is a distinction the user never
 * made, and the observed result is worse than an error: the model quietly
 * writes the document by hand instead, and two pages of invented prose come
 * back in place of the documentation.
 *
 * So the address is taken from whichever field the profile actually fills in.
 * The request then either reaches a cluster and returns a document, or does
 * not and returns an error worth reading.
 */
export const documentCredentials = (settings: ProviderSettings | undefined): ClusterCredentials | undefined => {
	const cluster = clusterCredentials(settings)
	if (cluster) {
		return cluster
	}
	if (!settings) {
		return undefined
	}
	// Every profile that points at a self-hosted OpenAI-compatible endpoint
	// fills in one of these. Ordered by how likely it is to be this cluster.
	const candidates: Array<[string | undefined, string | undefined]> = [
		[settings.aiClusterBaseUrl, settings.aiClusterApiKey],
		[settings.openAiBaseUrl, settings.openAiApiKey],
		[settings.litellmBaseUrl, settings.litellmApiKey],
		[settings.ollamaBaseUrl, settings.ollamaApiKey],
		[settings.lmStudioBaseUrl, undefined],
	]
	for (const [url, apiKey] of candidates) {
		const baseUrl = url?.trim()
		if (baseUrl && /^https?:\/\//i.test(baseUrl)) {
			return { baseUrl, apiKey }
		}
	}
	return undefined
}

export type ClusterIntegrationResult = {
	skills?: ClusterSkillsSyncResult
	skillsError?: string
	mcpRegistered?: boolean
	mcpError?: string
}

/**
 * Apply the current settings.
 *
 * `force` is what the "Sync skills now" button sends: it re-runs the sync even
 * when nothing looks like it changed, because the reason a user presses it is
 * that they just edited a SKILL.md on the node.
 */
export async function applyClusterIntegration(
	provider: ClineProvider,
	options: { force?: boolean } = {},
): Promise<ClusterIntegrationResult> {
	const { apiConfiguration } = await provider.getState()
	const credentials = clusterCredentials(apiConfiguration)
	const result: ClusterIntegrationResult = {}

	// Not on an AI Cluster profile: leave everything alone. Tearing down the
	// MCP entry and the mirrored skills every time the user switches to another
	// provider for one task would make both flap.
	if (!credentials) {
		return result
	}

	const wantsMcp = apiConfiguration.aiClusterRegisterMcp ?? true
	const wantsSkills = apiConfiguration.aiClusterSyncSkills ?? true

	try {
		const hub = provider.getMcpHub()
		if (hub) {
			const settingsPath = await hub.getMcpSettingsFilePath()
			result.mcpRegistered = wantsMcp
				? await registerClusterMcpServer(settingsPath, credentials.baseUrl)
				: !(await unregisterClusterMcpServer(settingsPath))
		}
	} catch (error) {
		result.mcpError = error instanceof Error ? error.message : String(error)
		provider.log(`AI Cluster: could not update the MCP server entry: ${result.mcpError}`)
	}

	if (!wantsSkills) {
		if (options.force) {
			await clearClusterSkills().catch(() => undefined)
			await provider.getSkillsManager()?.discoverSkills()
		}
		return result
	}

	try {
		result.skills = await syncClusterSkills(credentials)
		const { added, updated, removed, failed } = result.skills
		if (added.length || updated.length || removed.length || failed.length) {
			provider.log(
				`AI Cluster skills: +${added.length} ~${updated.length} -${removed.length}` +
					(failed.length ? ` (${failed.length} failed)` : ""),
			)
			await provider.getSkillsManager()?.discoverSkills()
		}
	} catch (error) {
		result.skillsError = error instanceof Error ? error.message : String(error)
		provider.log(`AI Cluster: skill sync failed: ${result.skillsError}`)
	}

	return result
}
