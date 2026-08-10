import axios from "axios"
import { z } from "zod"

import type { ModelInfo } from "@roo-code/types"
import {
	aiClusterDefaultModelInfo,
	isAiClusterReasoningModel,
	isAiClusterVisionModel,
	AI_CLUSTER_DEFAULT_MAX_TOKENS,
} from "@roo-code/types"

// The cluster's /v1/models is llama-swap's list, merged with any second box the
// middleware fronts. It carries an id and almost nothing else — no context
// window, no pricing, no capability flags — because llama.cpp does not know
// them either.
const modelSchema = z.object({
	id: z.string(),
	// Present only when the middleware is proxying a second machine; useful in
	// the picker because the alias and the real model differ there.
	served_model: z.string().optional(),
	owned_by: z.string().optional(),
	// Some builds do report these. Used when they are there, never required.
	context_length: z.number().optional(),
	context_window: z.number().optional(),
	max_model_len: z.number().optional(),
})

type ClusterModel = z.infer<typeof modelSchema>

const modelsResponseSchema = z.object({ data: z.array(z.unknown()) })

// /cluster/api-info is the middleware's own description of itself. `max_context`
// is the number that matters: the middleware compacts or trims anything longer
// before it ever reaches the model, so a client that believes in the model's
// nominal 128k window will keep handing over conversations that are silently
// summarised. Better to know the real ceiling and manage context against it.
const apiInfoSchema = z.object({
	max_context: z.number().optional(),
	default_model: z.string().optional(),
	pinned_model: z.string().optional(),
	capabilities: z
		.object({
			mcp: z.boolean().optional(),
			skills: z.boolean().optional(),
			documents: z.boolean().optional(),
			knowledge_base: z.boolean().optional(),
		})
		.partial()
		.optional(),
	endpoints: z.record(z.string(), z.string()).optional(),
})

export type AiClusterInfo = z.infer<typeof apiInfoSchema>

/** `http://host:18080/v1` → `http://host:18080`. Everything but /v1 lives at the root. */
export const aiClusterOrigin = (baseUrl: string): string => {
	const trimmed = (baseUrl || "").trim().replace(/\/+$/, "")
	return trimmed.replace(/\/v1$/, "")
}

/** `http://host:18080` or `http://host:18080/v1` → the /v1 base the SDK wants. */
export const aiClusterApiBase = (baseUrl: string): string => `${aiClusterOrigin(baseUrl)}/v1`

const authHeaders = (apiKey?: string): Record<string, string> => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {})

/**
 * Ask the middleware what it is. Best-effort: a cluster running an older build
 * has no such endpoint, and the model list is still perfectly usable without it.
 */
export async function getAiClusterInfo(baseUrl: string, apiKey?: string): Promise<AiClusterInfo | undefined> {
	try {
		const response = await axios.get(`${aiClusterOrigin(baseUrl)}/cluster/api-info`, {
			headers: authHeaders(apiKey),
			timeout: 5_000,
		})
		const parsed = apiInfoSchema.safeParse(response.data)
		return parsed.success ? parsed.data : undefined
	} catch {
		return undefined
	}
}

export const parseAiClusterModel = (model: ClusterModel, maxContext?: number): ModelInfo => {
	const reported = model.context_window ?? model.context_length ?? model.max_model_len
	// The lower of the two wins. A model that can hold 128k behind a middleware
	// configured for 32k still only gets 32k, and the reverse — a server willing
	// to accept more than the model can hold — ends in a 400 the middleware has
	// to trim its way out of.
	const contextWindow =
		reported && maxContext
			? Math.min(reported, maxContext)
			: (reported ?? maxContext ?? aiClusterDefaultModelInfo.contextWindow)

	return {
		...aiClusterDefaultModelInfo,
		contextWindow,
		// Never promise more completion room than a quarter of the window; on a
		// 32k deployment the 8k floor is already a third of it.
		maxTokens: Math.max(1_024, Math.min(AI_CLUSTER_DEFAULT_MAX_TOKENS, Math.floor(contextWindow / 4))),
		supportsImages: isAiClusterVisionModel(model.id),
		supportsReasoningEffort: isAiClusterReasoningModel(model.id),
		description: model.served_model
			? `${model.id} (served as ${model.served_model} by the cluster)`
			: `${model.id} on the AI Cluster`,
	}
}

/**
 * Models the cluster is currently able to serve.
 *
 * Returns an empty record rather than throwing: an unreachable cluster is the
 * normal state of a LAN box that is switched off, and the settings UI shows
 * "no models" far more usefully than an error toast on every refresh.
 */
export async function getAiClusterModels(baseUrl?: string, apiKey?: string): Promise<Record<string, ModelInfo>> {
	const models: Record<string, ModelInfo> = {}

	if (!baseUrl || !URL.canParse(aiClusterApiBase(baseUrl))) {
		return models
	}

	try {
		const [listResult, info] = await Promise.all([
			axios.get(`${aiClusterApiBase(baseUrl)}/models`, {
				headers: authHeaders(apiKey),
				timeout: 10_000,
			}),
			getAiClusterInfo(baseUrl, apiKey),
		])

		const parsed = modelsResponseSchema.safeParse(listResult.data)
		const raw = parsed.success ? parsed.data.data : listResult.data?.data
		const data = Array.isArray(raw) ? raw : []

		for (const entry of data) {
			const model = modelSchema.safeParse(entry)
			if (!model.success) {
				console.warn(`Skipping invalid AI Cluster model entry: ${JSON.stringify(entry)}`)
				continue
			}
			models[model.data.id] = parseAiClusterModel(model.data, info?.max_context)
		}
	} catch (error) {
		console.error(`Error fetching AI Cluster models: ${error instanceof Error ? error.message : String(error)}`)
	}

	return models
}
