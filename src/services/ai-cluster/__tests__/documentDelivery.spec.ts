import fs from "fs/promises"
import os from "os"
import path from "path"

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import axios from "axios"

import { deliveryNote, documentLinks, saveDocuments } from "../documentDelivery"
import { buildClusterDocument } from "../client"
import { documentCredentials } from "../index"

vi.mock("axios")

/**
 * A document that arrives as a link is a document the user still has to fetch
 * by hand. These hold the two things that stops: finding the links, and putting
 * the bytes where the user works.
 */

describe("documentLinks", () => {
	it("finds a link mentioned in prose", () => {
		const text = "Built it. Download: http://cluster:18080/v1/files/9f2c1a4b7e01/Q2%20report.docx"
		expect(documentLinks(text)).toEqual([
			{ url: "http://cluster:18080/v1/files/9f2c1a4b7e01/Q2%20report.docx", name: "Q2 report.docx" },
		])
	})

	it("drops the punctuation a sentence leaves on the end", () => {
		const text = "Here: http://c:18080/v1/files/abc123/report.pdf."
		expect(documentLinks(text)[0].name).toBe("report.pdf")
	})

	it("mentions each document once, however often the answer repeats it", () => {
		const url = "http://c:18080/v1/files/abc123/report.pdf"
		expect(documentLinks(`${url} and again ${url}`)).toHaveLength(1)
	})

	it("ignores every other URL on the cluster", () => {
		expect(documentLinks("see http://c:18080/v1/models and http://c:18080/mcp")).toEqual([])
	})

	it("never lets a name climb out of the directory", () => {
		const links = documentLinks("http://c:18080/v1/files/abc123/..%2F..%2Fescaped.docx")
		expect(links[0].name).toBe("escaped.docx")
	})
})

describe("saveDocuments", () => {
	let cwd: string

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-"))
		vi.mocked(axios.get).mockReset()
	})

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true })
	})

	it("writes the file into the workspace and says where", async () => {
		vi.mocked(axios.get).mockResolvedValue({ data: Buffer.from("PK pretend docx") })
		const { saved, failed } = await saveDocuments("Done: http://c:18080/v1/files/abc123/report.docx", cwd)

		expect(failed).toEqual([])
		expect(saved[0].relativePath).toBe("documents/report.docx")
		const written = await fs.readFile(path.join(cwd, "documents", "report.docx"))
		expect(written.toString()).toContain("pretend docx")
	})

	it("keeps both when two documents share a name", async () => {
		vi.mocked(axios.get).mockResolvedValue({ data: Buffer.from("one") })
		await saveDocuments("http://c:18080/v1/files/aaa111/report.docx", cwd)
		await saveDocuments("http://c:18080/v1/files/bbb222/report.docx", cwd)

		const entries = await fs.readdir(path.join(cwd, "documents"))
		expect(entries.sort()).toEqual(["report-2.docx", "report.docx"])
	})

	it("reports a download that failed instead of pretending it worked", async () => {
		vi.mocked(axios.get).mockRejectedValue(new Error("connect ECONNREFUSED"))
		const { saved, failed } = await saveDocuments("http://c:18080/v1/files/abc123/report.docx", cwd)

		expect(saved).toEqual([])
		expect(failed[0].error).toContain("ECONNREFUSED")
	})

	it("does nothing at all when there is no document in the text", async () => {
		const { saved, failed } = await saveDocuments("an ordinary answer", cwd)
		expect(saved).toEqual([])
		expect(failed).toEqual([])
		expect(vi.mocked(axios.get)).not.toHaveBeenCalled()
	})
})

describe("deliveryNote", () => {
	it("tells the model to report a path rather than a link", () => {
		const note = deliveryNote(
			[{ url: "u", name: "report.docx", relativePath: "documents/report.docx", bytes: 66_000 }],
			[],
		)
		expect(note).toContain("documents/report.docx")
		expect(note).toContain("64 KB")
		expect(note).toContain("already downloaded")
	})

	it("says the link still works when the download did not", () => {
		expect(deliveryNote([], [{ url: "http://c/v1/files/a/b.docx", error: "timeout" }])).toContain(
			"the link still works",
		)
	})
})

describe("buildClusterDocument", () => {
	beforeEach(() => {
		vi.mocked(axios.post).mockReset()
	})

	it("returns the bytes the cluster built", async () => {
		vi.mocked(axios.post).mockResolvedValue({ status: 200, data: Buffer.from("PK docx"), headers: {} })
		const buffer = await buildClusterDocument({ baseUrl: "http://c:18080/v1" }, { format: "docx", brief: "x" })
		expect(buffer.toString()).toBe("PK docx")
		expect(vi.mocked(axios.post).mock.calls[0][0]).toBe("http://c:18080/v1/documents/docx?download=1")
	})

	it("reads a refusal out of the header, because the body is a document", async () => {
		// With ?download=1 the cluster answers a refusal with a rendered
		// explanation. A program cannot read a .docx to find out what to fix, so
		// the same reason is repeated in a header.
		vi.mocked(axios.post).mockResolvedValue({
			status: 400,
			data: Buffer.from("PK a document explaining itself"),
			headers: { "x-document-refused": "This brief is 39 characters restating the request." },
		})
		await expect(
			buildClusterDocument({ baseUrl: "http://c:18080/v1" }, { format: "docx", brief: "x" }),
		).rejects.toThrow("39 characters restating the request")
	})

	it("falls back to the JSON error when there is no header", async () => {
		vi.mocked(axios.post).mockResolvedValue({
			status: 400,
			data: Buffer.from(JSON.stringify({ error: { message: 'add "format" to the request' } })),
			headers: {},
		})
		await expect(
			buildClusterDocument({ baseUrl: "http://c:18080/v1" }, { format: "docx", brief: "x" }),
		).rejects.toThrow('add "format" to the request')
	})

	it("puts the format in the path and the inventory in the body", async () => {
		vi.mocked(axios.post).mockResolvedValue({ status: 200, data: Buffer.from("PK"), headers: {} })
		await buildClusterDocument(
			{ baseUrl: "http://c:18080/v1" },
			{ format: "pptx", brief: "x", deck: true, appendBlocks: [{ type: "table" }] },
		)
		const [url, body] = vi.mocked(axios.post).mock.calls[0]
		expect(url).toContain("/v1/documents/pptx")
		expect((body as Record<string, unknown>).append_blocks).toHaveLength(1)
		expect((body as Record<string, unknown>).deck).toBe(true)
	})
})

describe("documentCredentials", () => {
	it("uses the AI Cluster profile when that is what the user picked", () => {
		expect(
			documentCredentials({
				apiProvider: "ai-cluster",
				aiClusterBaseUrl: "http://c:18080/v1",
				aiClusterApiKey: "k",
			} as never),
		).toEqual({ baseUrl: "http://c:18080/v1", apiKey: "k" })
	})

	it("accepts an OpenAI Compatible profile pointing at the same address", () => {
		// This is what the cluster's README told people to set up for months.
		expect(
			documentCredentials({
				apiProvider: "openai",
				openAiBaseUrl: "http://c:18080/v1",
				openAiApiKey: "k",
			} as never),
		).toEqual({ baseUrl: "http://c:18080/v1", apiKey: "k" })
	})

	it("accepts the other self-hosted profiles too", () => {
		expect(
			documentCredentials({ apiProvider: "lmstudio", lmStudioBaseUrl: "http://c:1234/v1" } as never)?.baseUrl,
		).toBe("http://c:1234/v1")
		expect(documentCredentials({ apiProvider: "ollama", ollamaBaseUrl: "http://c:11434" } as never)?.baseUrl).toBe(
			"http://c:11434",
		)
	})

	it("gives up on a profile with no address of its own", () => {
		expect(documentCredentials({ apiProvider: "anthropic", apiKey: "sk-x" } as never)).toBeUndefined()
		expect(documentCredentials(undefined)).toBeUndefined()
	})
})
