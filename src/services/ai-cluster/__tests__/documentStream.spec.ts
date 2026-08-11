import { Readable } from "stream"

import { describe, it, expect, vi, beforeEach } from "vitest"
import axios from "axios"

import { buildClusterDocument } from "../client"

vi.mock("axios")

const credentials = { baseUrl: "http://cluster:18080/v1", apiKey: "k" }
const request = { format: "docx" as const, brief: "material" }

/** An SSE body, delivered in whatever chunks the test wants to prove survive. */
const sse = (chunks: string[]) => Readable.from(chunks)

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

describe("buildClusterDocument with progress", () => {
	beforeEach(() => vi.clearAllMocks())

	it("reports each stage and returns the document from the last event", async () => {
		vi.mocked(axios.post).mockResolvedValue({
			status: 200,
			headers: { "content-type": "text/event-stream" },
			data: sse([
				frame("progress", { percent: 8, stage: "outline", message: "Planned 9 sections" }),
				frame("progress", { percent: 35, stage: "section", message: "Wrote section 4 of 9" }),
				frame("result", { ok: true, content_base64: Buffer.from("DOCX").toString("base64") }),
			]),
		} as never)

		const seen: string[] = []
		const buffer = await buildClusterDocument(credentials, request, (event) =>
			seen.push(`${event.percent}:${event.message}`),
		)

		expect(seen).toEqual(["8:Planned 9 sections", "35:Wrote section 4 of 9"])
		expect(buffer.toString()).toBe("DOCX")
		expect(vi.mocked(axios.post).mock.calls[0][0]).toContain("/v1/documents/docx?stream=1")
	})

	it("reads frames that arrive split across chunks", async () => {
		const whole = frame("progress", { percent: 50, stage: "section", message: "Wrote section 5 of 10" })
		vi.mocked(axios.post).mockResolvedValue({
			status: 200,
			headers: { "content-type": "text/event-stream" },
			data: sse([
				whole.slice(0, 12),
				whole.slice(12),
				frame("result", { content_base64: Buffer.from("PDF").toString("base64") }),
			]),
		} as never)

		const seen: number[] = []
		const buffer = await buildClusterDocument(credentials, request, (event) => seen.push(event.percent))
		expect(seen).toEqual([50])
		expect(buffer.toString()).toBe("PDF")
	})

	it("never lets the bar run backwards", async () => {
		vi.mocked(axios.post).mockResolvedValue({
			status: 200,
			headers: { "content-type": "text/event-stream" },
			data: sse([
				frame("progress", { percent: 42, stage: "section", message: "Wrote section 5 of 9" }),
				frame("progress", { percent: 35, stage: "retry", message: "Section 5 came back unusable" }),
				frame("result", { content_base64: Buffer.from("X").toString("base64") }),
			]),
		} as never)

		const seen: number[] = []
		await buildClusterDocument(credentials, request, (event) => seen.push(event.percent))
		expect(seen).toEqual([42, 42])
	})

	it("raises what the cluster said when it fails mid-document", async () => {
		vi.mocked(axios.post).mockResolvedValue({
			status: 200,
			headers: { "content-type": "text/event-stream" },
			data: sse([frame("error", { error: { message: "the model could not write a usable spec" } })]),
		} as never)

		await expect(buildClusterDocument(credentials, request, () => {})).rejects.toThrow(
			"the model could not write a usable spec",
		)
	})

	it("falls back to the buffered request when the cluster does not stream", async () => {
		// An older cluster answers the stream request with ordinary JSON. That is
		// a missing feature, not a failure: the document still has to be built.
		vi.mocked(axios.post).mockImplementation(async (url: unknown) =>
			String(url).includes("stream=1")
				? ({
						status: 404,
						headers: { "content-type": "application/json" },
						data: { destroy: () => {} },
					} as never)
				: ({ status: 200, headers: {}, data: Buffer.from("FALLBACK") } as never),
		)

		const buffer = await buildClusterDocument(credentials, request, () => {})
		expect(buffer.toString()).toBe("FALLBACK")
		expect(vi.mocked(axios.post).mock.calls[1][0]).toContain("download=1")
	})
})
