// npx vitest run src/api/providers/fetchers/__tests__/ai-cluster.spec.ts

import axios from "axios"

import { getAiClusterModels, aiClusterApiBase, aiClusterOrigin, parseAiClusterModel } from "../ai-cluster"

vitest.mock("axios")

const mockedAxios = axios as unknown as { get: ReturnType<typeof vitest.fn> }

const modelsResponse = {
	data: {
		object: "list",
		data: [
			{ id: "gpt-oss-120b", owned_by: "cluster" },
			{ id: "qwen3-vl-32b", owned_by: "cluster", context_length: 262144 },
			{ id: "lmstudio", owned_by: "lmstudio", served_model: "glm-4.6" },
		],
	},
}

const infoResponse = {
	data: {
		max_context: 131072,
		default_model: "gpt-oss-120b",
		capabilities: { mcp: true, skills: true, documents: true, knowledge_base: false },
	},
}

describe("aiClusterOrigin / aiClusterApiBase", () => {
	it("strips a trailing /v1 and any trailing slashes", () => {
		expect(aiClusterOrigin("http://10.0.0.5:18080/v1")).toBe("http://10.0.0.5:18080")
		expect(aiClusterOrigin("http://10.0.0.5:18080/v1/")).toBe("http://10.0.0.5:18080")
		expect(aiClusterOrigin("http://10.0.0.5:18080")).toBe("http://10.0.0.5:18080")
	})

	it("normalises either form to the /v1 base the SDK needs", () => {
		expect(aiClusterApiBase("http://10.0.0.5:18080")).toBe("http://10.0.0.5:18080/v1")
		expect(aiClusterApiBase("http://10.0.0.5:18080/v1")).toBe("http://10.0.0.5:18080/v1")
	})
})

describe("parseAiClusterModel", () => {
	it("uses the middleware's ceiling when the model claims more", () => {
		// The middleware compacts anything longer before the model sees it, so the
		// larger number would only produce silently summarised conversations.
		const info = parseAiClusterModel({ id: "qwen3-32b", context_length: 262144 }, 32768)
		expect(info.contextWindow).toBe(32768)
	})

	it("uses the model's window when it is the smaller of the two", () => {
		const info = parseAiClusterModel({ id: "small", context_length: 8192 }, 131072)
		expect(info.contextWindow).toBe(8192)
	})

	it("never promises more completion room than a quarter of the window", () => {
		const info = parseAiClusterModel({ id: "small", context_length: 8192 }, 8192)
		expect(info.maxTokens).toBe(2048)
	})

	it("caps completion room at the middleware's tool-turn floor", () => {
		const info = parseAiClusterModel({ id: "gpt-oss-120b" }, 131072)
		expect(info.maxTokens).toBe(8192)
	})

	it("flags reasoning and vision from the model name", () => {
		expect(parseAiClusterModel({ id: "gpt-oss-120b" }, 32768).supportsReasoningEffort).toBe(true)
		expect(parseAiClusterModel({ id: "qwen3-vl-32b" }, 32768).supportsImages).toBe(true)
		expect(parseAiClusterModel({ id: "llama-3-8b" }, 32768).supportsImages).toBe(false)
	})

	it("never claims prompt caching", () => {
		// Claiming it makes the generic path attach cache_control blocks that this
		// server ignores while inflating every message.
		expect(parseAiClusterModel({ id: "gpt-oss-120b" }, 32768).supportsPromptCache).toBe(false)
	})
})

describe("getAiClusterModels", () => {
	beforeEach(() => {
		vitest.clearAllMocks()
	})

	it("returns every model the cluster serves, capped by its context ceiling", async () => {
		mockedAxios.get = vitest
			.fn()
			.mockImplementation((url: string) =>
				Promise.resolve(url.includes("/cluster/api-info") ? infoResponse : modelsResponse),
			)

		const models = await getAiClusterModels("http://10.0.0.5:18080/v1", "key")

		expect(Object.keys(models).sort()).toEqual(["gpt-oss-120b", "lmstudio", "qwen3-vl-32b"])
		expect(models["gpt-oss-120b"].contextWindow).toBe(131072)
		// Reported 262144, ceiling 131072.
		expect(models["qwen3-vl-32b"].contextWindow).toBe(131072)
		expect(models["lmstudio"].description).toContain("glm-4.6")
	})

	it("sends the API key when there is one", async () => {
		mockedAxios.get = vitest.fn().mockResolvedValue(modelsResponse)
		await getAiClusterModels("http://10.0.0.5:18080/v1", "secret")
		expect(mockedAxios.get).toHaveBeenCalledWith(
			"http://10.0.0.5:18080/v1/models",
			expect.objectContaining({ headers: { Authorization: "Bearer secret" } }),
		)
	})

	it("works without api-info, which older deployments do not have", async () => {
		mockedAxios.get = vitest
			.fn()
			.mockImplementation((url: string) =>
				url.includes("/cluster/api-info") ? Promise.reject(new Error("404")) : Promise.resolve(modelsResponse),
			)

		const models = await getAiClusterModels("http://10.0.0.5:18080/v1")
		expect(models["gpt-oss-120b"].contextWindow).toBe(32768)
	})

	it("returns nothing rather than throwing when the cluster is off", async () => {
		// A LAN box being switched off is the normal state, not an error worth a
		// toast on every settings render.
		mockedAxios.get = vitest.fn().mockRejectedValue(new Error("ECONNREFUSED"))
		expect(await getAiClusterModels("http://10.0.0.5:18080/v1")).toEqual({})
	})

	it("returns nothing when no base URL is configured", async () => {
		mockedAxios.get = vitest.fn()
		expect(await getAiClusterModels(undefined)).toEqual({})
		expect(mockedAxios.get).not.toHaveBeenCalled()
	})

	it("skips malformed entries instead of failing the whole list", async () => {
		mockedAxios.get = vitest.fn().mockResolvedValue({
			data: { data: [{ id: "good" }, { notAnId: true }] },
		})
		const models = await getAiClusterModels("http://10.0.0.5:18080/v1")
		expect(Object.keys(models)).toEqual(["good"])
	})
})
