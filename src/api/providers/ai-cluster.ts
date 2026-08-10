import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import {
	aiClusterDefaultModelId,
	aiClusterDefaultModelInfo,
	isAiClusterReasoningModel,
	AI_CLUSTER_DEFAULT_BASE_URL,
} from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"

import { ApiStream } from "../transform/stream"
import { convertToOpenAiMessages } from "../transform/openai-format"

import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata, CompletePromptOptions } from "../index"
import { RouterProvider } from "./router-provider"
import { aiClusterApiBase } from "./fetchers/ai-cluster"
import { extractReasoningFromDelta } from "./utils/extract-reasoning"

/**
 * A self-hosted AI Cluster: llama.cpp (via llama-swap) behind a Django
 * middleware that adds queueing, context compaction, a skill router and its own
 * tool endpoints, all on one port.
 *
 * It speaks OpenAI, so the generic "OpenAI Compatible" provider connects — but
 * four of its behaviours are not the OpenAI ones, and each was a real failure
 * rather than a theoretical mismatch:
 *
 *   * **`max_tokens`, not `max_completion_tokens`.** The middleware raises a
 *     tool turn's budget to a floor so reasoning cannot consume the whole
 *     completion before the tool call is emitted — and it reads `max_tokens`.
 *     A request carrying only the modern field skipped that floor entirely.
 *   * **No `cache_control`.** Nothing here bills for or reports cached tokens;
 *     attaching cache blocks only converts every message into the multi-part
 *     form for a server that ignores them.
 *   * **Reasoning effort is a template argument.** llama.cpp takes it in
 *     `chat_template_kwargs`, not as the top-level OpenAI field.
 *   * **Failure modes are local ones.** A queue that is full, a box that is
 *     off, a model still loading: each needs a sentence a user can act on, not
 *     a bare 503.
 */
export class AiClusterHandler extends RouterProvider implements SingleCompletionHandler {
	constructor(options: ApiHandlerOptions) {
		super({
			options,
			name: "ai-cluster",
			baseURL: aiClusterApiBase(options.aiClusterBaseUrl || AI_CLUSTER_DEFAULT_BASE_URL),
			// The middleware forwards whatever Authorization it is given, and many
			// deployments run open on a private LAN. The SDK still insists on a
			// non-empty key.
			apiKey: options.aiClusterApiKey || "not-provided",
			modelId: options.aiClusterModelId,
			defaultModelId: aiClusterDefaultModelId,
			defaultModelInfo: aiClusterDefaultModelInfo,
		})
	}

	/**
	 * llama.cpp's template arguments. The middleware already forces the Harmony
	 * analysis channel on for tool turns; this only carries the user's chosen
	 * effort, and only for models that have one.
	 */
	private templateKwargs(modelId: string): Record<string, unknown> | undefined {
		const effort = this.options.reasoningEffort
		if (!effort || !isAiClusterReasoningModel(modelId)) {
			return undefined
		}
		return { reasoning_effort: effort }
	}

	/**
	 * Tools, unmangled.
	 *
	 * The shared helper prepares schemas for OpenAI strict mode, which means
	 * putting *every* property into `required`. OpenAI needs that; llama.cpp does
	 * not — it ignores `strict` and builds its grammar straight from the schema,
	 * so the rewritten version tells the model that read_file's optional
	 * `start_line` must always be supplied. The model duly invents one. Sending
	 * the schema as written keeps optional parameters optional.
	 */
	private clusterTools(tools: unknown[] | undefined): unknown[] | undefined {
		return tools && tools.length > 0 ? tools : undefined
	}

	private requestBody(
		modelId: string,
		messages: OpenAI.Chat.ChatCompletionMessageParam[],
		maxTokens: number | undefined,
		metadata?: ApiHandlerCreateMessageMetadata,
	): Record<string, unknown> {
		const tools = this.clusterTools(metadata?.tools)
		const templateKwargs = this.templateKwargs(modelId)

		return {
			model: modelId,
			messages,
			// Omitted unless the user chose one: the middleware applies the
			// model-appropriate sampling defaults (gpt-oss wants temperature 1.0,
			// which is nothing like the 0 a coding agent would otherwise force).
			...(this.options.modelTemperature != null && { temperature: this.options.modelTemperature }),
			// The deprecated field is the one this server reads. See the class note.
			...(maxTokens ? { max_tokens: maxTokens } : {}),
			...(tools ? { tools, tool_choice: metadata?.tool_choice ?? "auto" } : {}),
			// Only meaningful alongside tools, and llama.cpp builds differ on
			// whether they tolerate it on a plain chat request.
			...(tools ? { parallel_tool_calls: metadata?.parallelToolCalls ?? true } : {}),
			...(templateKwargs ? { chat_template_kwargs: templateKwargs } : {}),
		}
	}

	/**
	 * Turn a transport failure into something the user can act on. The cluster's
	 * distinctive errors are all "this machine, right now" problems, and the raw
	 * text ("server busy, try again", a bare ECONNREFUSED) does not say which.
	 */
	private describeError(error: unknown): Error {
		const err = error as { status?: number; code?: string; message?: string }
		const base = this.client.baseURL
		const message = err?.message ?? String(error)

		if (err?.code === "ECONNREFUSED" || err?.code === "ENOTFOUND" || err?.code === "EHOSTUNREACH") {
			return new Error(
				`AI Cluster unreachable at ${base}. Check the node is powered on and the base URL is right (${message}).`,
			)
		}
		if (err?.status === 503) {
			return new Error(
				`AI Cluster is busy: every slot is taken and the queue timed out. Retry, or raise N_SLOTS / QUEUE_TIMEOUT on the node (${message}).`,
			)
		}
		if (err?.status === 401 || err?.status === 403) {
			return new Error(`AI Cluster rejected the API key (${message}).`)
		}
		if (err?.status === 404) {
			return new Error(`AI Cluster has no such endpoint at ${base}. The base URL should end in /v1 (${message}).`)
		}
		return new Error(`AI Cluster request failed: ${message}`)
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const { id: modelId, info } = await this.fetchModel()

		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		const body = {
			...this.requestBody(
				modelId,
				openAiMessages,
				this.options.modelMaxTokens || info.maxTokens || undefined,
				metadata,
			),
			stream: true,
			stream_options: { include_usage: true },
		} as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming

		let stream
		try {
			stream = await this.client.chat.completions.create(body)
		} catch (error) {
			throw this.describeError(error)
		}

		const activeToolCallIds = new Set<string>()

		try {
			for await (const chunk of stream) {
				const delta = chunk.choices?.[0]?.delta
				const finishReason = chunk.choices?.[0]?.finish_reason

				if (delta?.content) {
					yield { type: "text", text: delta.content }
				}

				// gpt-oss streams its Harmony analysis channel as reasoning_content;
				// other local builds use `reasoning`. The shared helper takes both.
				const reasoningText = extractReasoningFromDelta(delta)
				if (reasoningText) {
					yield { type: "reasoning", text: reasoningText }
				}

				if (delta?.tool_calls) {
					for (const toolCall of delta.tool_calls) {
						if (toolCall.id) {
							activeToolCallIds.add(toolCall.id)
						}
						yield {
							type: "tool_call_partial",
							index: toolCall.index,
							id: toolCall.id,
							name: toolCall.function?.name,
							arguments: toolCall.function?.arguments,
						}
					}
				}

				// llama.cpp does not always close a tool call cleanly at the end of
				// a stream; finish_reason is the reliable signal that it is done.
				if (finishReason === "tool_calls" && activeToolCallIds.size > 0) {
					for (const id of activeToolCallIds) {
						yield { type: "tool_call_end", id }
					}
					activeToolCallIds.clear()
				}

				if (chunk.usage) {
					yield {
						type: "usage",
						inputTokens: chunk.usage.prompt_tokens || 0,
						outputTokens: chunk.usage.completion_tokens || 0,
					}
				}
			}
		} catch (error) {
			// Mid-stream failures reach here as thrown errors — including the
			// middleware's own `data: {"error": ...}` frames, which the SDK raises.
			throw this.describeError(error)
		}
	}

	async completePrompt(prompt: string, _options?: CompletePromptOptions): Promise<string> {
		const { id: modelId, info } = await this.fetchModel()

		try {
			const response = (await this.client.chat.completions.create({
				...this.requestBody(modelId, [{ role: "user", content: prompt }], info.maxTokens ?? undefined),
				stream: false,
			} as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming)) as OpenAI.Chat.ChatCompletion

			return response.choices?.[0]?.message?.content || ""
		} catch (error) {
			throw this.describeError(error)
		}
	}
}
