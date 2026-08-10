import type { ModelInfo } from "../model.js"

// AI Cluster: a self-hosted rig (llama.cpp / llama-swap behind a Django
// middleware) that serves an OpenAI-compatible API on one port, plus its own
// skills endpoint and an MCP server. It is reachable only on the user's LAN, so
// there is no default host to ship — the base URL is required configuration.
//
// This exists as its own provider rather than as "OpenAI Compatible" because
// the differences are behavioural, not cosmetic:
//
//   * the middleware reads `max_tokens`; the generic provider sends
//     `max_completion_tokens`, so its budget floor for tool turns never fired
//   * `cache_control` blocks are meaningless here and turn every message into
//     the multi-part content form for no gain
//   * the context window is whatever the middleware will accept (it compacts
//     above that), which the server reports and no client can guess
//   * the same host answers /v1/skills and /mcp, which nothing generic knows
//     to look for
export const AI_CLUSTER_DEFAULT_BASE_URL = "http://localhost:18080/v1"

// Only a placeholder for the model picker before the live list resolves: the
// cluster's own list comes from /v1/models and is the only source of truth.
export const aiClusterDefaultModelId = "gpt-oss-120b"

// What the middleware defaults to when the operator sets nothing (MAX_CONTEXT).
// Overridden per-deployment by the value /cluster/api-info reports.
export const AI_CLUSTER_DEFAULT_CONTEXT_WINDOW = 32_768

// The middleware raises a tool turn's budget to this floor (MIN_TOOL_MAX_TOKENS)
// so reasoning cannot eat the whole completion before the tool call is emitted.
// Matching it here keeps the number the UI shows equal to the number in effect.
export const AI_CLUSTER_DEFAULT_MAX_TOKENS = 8_192

export const aiClusterDefaultModelInfo: ModelInfo = {
	maxTokens: AI_CLUSTER_DEFAULT_MAX_TOKENS,
	contextWindow: AI_CLUSTER_DEFAULT_CONTEXT_WINDOW,
	supportsImages: false,
	// llama.cpp reuses the KV cache for a repeated prefix and the middleware asks
	// for it (`cache_prompt`), but nothing reports cached tokens back and the
	// server rejects nothing for their absence. Claiming prompt caching here
	// would only make the generic path attach `cache_control` blocks that mean
	// nothing to this server and inflate every message.
	supportsPromptCache: false,
	inputPrice: 0,
	outputPrice: 0,
	description: "Self-hosted AI Cluster model. The live list comes from the cluster's /v1/models.",
}

/**
 * Models that stream their thinking on `reasoning_content` and accept a
 * reasoning effort. gpt-oss needs the Harmony analysis channel switched on for
 * reliable tool calls, and the middleware turns it on for every tool turn — the
 * effort level is the part a user gets to choose.
 */
export const isAiClusterReasoningModel = (modelId: string): boolean => {
	const id = modelId.toLowerCase()
	return (
		id.includes("gpt-oss") ||
		id.includes("gpt_oss") ||
		id.includes("qwq") ||
		id.includes("deepseek-r1") ||
		id.includes("qwen3")
	)
}

/** Vision-capable local builds, by the naming every GGUF repo actually uses. */
export const isAiClusterVisionModel = (modelId: string): boolean => {
	const id = modelId.toLowerCase()
	return (
		id.includes("-vl") ||
		id.includes("vision") ||
		id.includes("llava") ||
		id.includes("gemma-3") ||
		id.includes("pixtral") ||
		id.includes("internvl")
	)
}
