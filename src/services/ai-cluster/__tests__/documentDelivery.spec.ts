import fs from "fs/promises"
import os from "os"
import path from "path"

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import axios from "axios"

import { deliveryNote, documentLinks, saveDocuments } from "../documentDelivery"

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
