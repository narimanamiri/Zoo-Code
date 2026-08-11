import { describe, it, expect, vi, beforeEach } from "vitest"
import * as fs from "fs/promises"

import { documentProjectTool } from "../DocumentProjectTool"
import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"
import type { DocumentProjectParams } from "../../../shared/tools"
import { buildClusterDocument } from "../../../services/ai-cluster/client"
import { digestRepository } from "../../../services/ai-cluster/repoDigest"

vi.mock("fs/promises")
vi.mock("../../../utils/pathUtils", () => ({ isPathOutsideWorkspace: () => false }))
vi.mock("../../../services/ai-cluster/client", () => ({ buildClusterDocument: vi.fn() }))
vi.mock("../../../services/ai-cluster/repoDigest", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../services/ai-cluster/repoDigest")>()
	return { ...actual, digestRepository: vi.fn() }
})

const digest = {
	name: "sample",
	root: "/test/workspace",
	fileCount: 42,
	totalLines: 8_000,
	truncated: false,
	directories: [{ name: "src", files: 40, lines: 7_500 }],
	files: [{ path: "src/a.ts", lines: 100, purpose: "does a thing", defines: ["a"] }],
	configs: [],
	imports: [{ from: "src/a", to: "src/b" }],
}

/**
 * Stand-ins for Task and the callbacks. A Task carries far more than this tool
 * touches, so these are built from what it actually uses — and built by a
 * function so the tests have a type to hold them in without asserting a shape
 * the tool does not depend on.
 */
const makeTask = (
	apiConfiguration: Record<string, unknown> = {
		apiProvider: "ai-cluster",
		aiClusterBaseUrl: "http://cluster:18080/v1",
	},
) => ({
	cwd: "/test/workspace",
	consecutiveMistakeCount: 0,
	didEditFile: false,
	didToolFailInCurrentTurn: false,
	recordToolError: vi.fn(),
	sayAndCreateMissingParamError: vi.fn().mockResolvedValue("missing"),
	say: vi.fn(),
	fileContextTracker: { trackFileContext: vi.fn() },
	rooIgnoreController: { validateAccess: vi.fn().mockReturnValue(true) },
	rooProtectedController: { isWriteProtected: vi.fn().mockReturnValue(false) },
	providerRef: { deref: () => ({ getState: vi.fn().mockResolvedValue({ apiConfiguration }) }) },
})

const makeCallbacks = () => ({
	askApproval: vi.fn().mockResolvedValue(true),
	handleError: vi.fn(),
	pushToolResult: vi.fn(),
})

type FakeTask = ReturnType<typeof makeTask>
type FakeCallbacks = ReturnType<typeof makeCallbacks>

/** The tool is written against the real Task; these carry only what it reads. */
const run = (params: DocumentProjectParams, task: FakeTask, callbacks: FakeCallbacks) =>
	documentProjectTool.execute(params, task as unknown as Task, callbacks as unknown as ToolCallbacks)

const resultOf = (callbacks: FakeCallbacks): string => String(callbacks.pushToolResult.mock.calls[0][0])

describe("documentProjectTool", () => {
	let task: FakeTask
	let callbacks: FakeCallbacks

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(digestRepository).mockResolvedValue(digest)
		vi.mocked(buildClusterDocument).mockResolvedValue(Buffer.alloc(120_000, 1))
		task = makeTask()
		callbacks = makeCallbacks()
	})

	it("reads the project, builds the document, and writes it into the workspace", async () => {
		await run({ path: "docs/manual.docx", source: null, title: null, author: null }, task, callbacks)

		expect(vi.mocked(buildClusterDocument).mock.calls[0][1].format).toBe("docx")
		// The brief is the material, not the request: it has to carry the files.
		expect(vi.mocked(buildClusterDocument).mock.calls[0][1].brief).toContain("src/a.ts")
		expect(vi.mocked(fs.writeFile)).toHaveBeenCalled()
		expect(task.didEditFile).toBe(true)

		const result = resultOf(callbacks)
		expect(result).toContain("docs/manual.docx")
		expect(result).toContain("nothing to download")
	})

	it("takes the format from the file extension", async () => {
		await run({ path: "docs/a.pdf", source: null, title: null, author: null }, task, callbacks)
		expect(vi.mocked(buildClusterDocument).mock.calls[0][1].format).toBe("pdf")

		vi.mocked(buildClusterDocument).mockClear()
		await run({ path: "d.pptx", source: null, title: null, author: null }, task, callbacks)
		expect(vi.mocked(buildClusterDocument).mock.calls[0][1].format).toBe("pptx")
		// A deck gets no appendix: the cluster refuses document blocks on slides.
		expect(vi.mocked(buildClusterDocument).mock.calls[0][1].appendBlocks).toBeUndefined()
	})

	it("refuses a format it cannot build", async () => {
		await run({ path: "notes.md", source: null, title: null, author: null }, task, callbacks)
		expect(vi.mocked(buildClusterDocument)).not.toHaveBeenCalled()
		expect(resultOf(callbacks)).toContain(".docx, .pdf or .pptx")
	})

	it("does not put the assistant's own name on the cover", async () => {
		await run({ path: "a.docx", source: null, title: null, author: "Zoo" }, task, callbacks)
		expect(vi.mocked(buildClusterDocument).mock.calls[0][1].author).toBeUndefined()

		vi.mocked(buildClusterDocument).mockClear()
		await run({ path: "a.docx", source: null, title: null, author: "Nariman Amiri" }, task, callbacks)
		expect(vi.mocked(buildClusterDocument).mock.calls[0][1].author).toBe("Nariman Amiri")
	})

	it("works from an OpenAI Compatible profile pointing at the cluster", async () => {
		// The AI Cluster provider was added late. Anyone who set this up before
		// it existed has this profile, and refusing it sends the model off to
		// write the document by hand — two pages of prose about a codebase
		// nobody read, which is exactly what was reported.
		task.providerRef = {
			deref: () => ({
				getState: vi.fn().mockResolvedValue({
					apiConfiguration: {
						apiProvider: "openai",
						openAiBaseUrl: "http://cluster:18080/v1",
						openAiApiKey: "k",
					},
				}),
			}),
		}
		await run({ path: "a.docx", source: null, title: null, author: null }, task, callbacks)

		expect(vi.mocked(buildClusterDocument)).toHaveBeenCalled()
		expect(vi.mocked(buildClusterDocument).mock.calls[0][0]).toEqual({
			baseUrl: "http://cluster:18080/v1",
			apiKey: "k",
		})
	})

	it("says what to do when the profile names no cluster at all", async () => {
		task.providerRef = {
			deref: () => ({ getState: vi.fn().mockResolvedValue({ apiConfiguration: { apiProvider: "anthropic" } }) }),
		}
		await run({ path: "a.docx", source: null, title: null, author: null }, task, callbacks)

		expect(vi.mocked(buildClusterDocument)).not.toHaveBeenCalled()
		const result = resultOf(callbacks)
		expect(result).toContain("does not point at one")
		// And tells the model not to fall back to writing it itself.
		expect(result).toContain("Do not write the document by hand")
	})

	it("passes the cluster's refusal through verbatim, since it says what to fix", async () => {
		vi.mocked(buildClusterDocument).mockRejectedValue(new Error('add "format" to the request'))
		await run({ path: "a.docx", source: null, title: null, author: null }, task, callbacks)

		// The result is the error envelope, so the message is read out of it
		// rather than matched raw — what matters is that nothing was reworded.
		const payload = JSON.parse(resultOf(callbacks))
		expect(payload.error).toBe('add "format" to the request')
		expect(vi.mocked(fs.writeFile)).not.toHaveBeenCalled()
	})

	it("stops when there is nothing under the source directory", async () => {
		vi.mocked(digestRepository).mockResolvedValue({ ...digest, fileCount: 0, files: [] })
		await run({ path: "a.docx", source: "empty", title: null, author: null }, task, callbacks)

		expect(vi.mocked(buildClusterDocument)).not.toHaveBeenCalled()
		expect(resultOf(callbacks)).toContain("No source files found")
	})

	it("does nothing at all when the user declines", async () => {
		callbacks.askApproval.mockResolvedValue(false)
		await run({ path: "a.docx", source: null, title: null, author: null }, task, callbacks)

		expect(vi.mocked(digestRepository)).not.toHaveBeenCalled()
		expect(vi.mocked(buildClusterDocument)).not.toHaveBeenCalled()
	})

	// Real events arrive tens of seconds apart; these arrive far enough apart to
	// clear the repaint throttle, which is the only timing the tool cares about.
	const settle = () => new Promise((resolve) => setTimeout(resolve, 200))

	it("draws a progress bar in one row that rewrites itself", async () => {
		// The cluster reports where it has got to; the tool paints it.
		vi.mocked(buildClusterDocument).mockImplementation(async (_creds, _request, onProgress) => {
			onProgress?.({ percent: 8, stage: "outline", message: "Planned 9 sections" })
			await settle()
			onProgress?.({ percent: 35, stage: "section", message: "Wrote section 4 of 9" })
			await settle()
			onProgress?.({ percent: 100, stage: "done", message: "Document ready" })
			await settle()
			return Buffer.alloc(1000, 1)
		})

		await run({ path: "a.docx", source: null, title: null, author: null }, task, callbacks)

		const said = task.say.mock.calls.filter((call) => call[0] === "text")
		const partials = said.filter((call) => call[3] === true)
		const finals = said.filter((call) => call[3] === false)
		expect(partials.length).toBeGreaterThan(1)
		expect(finals).toHaveLength(1)

		const painted = partials.map((call) => String(call[1])).join("\n")
		expect(painted).toContain("Wrote section 4 of 9")
		expect(painted).toContain("█") // a filled cell
		expect(painted).toContain("░") // an empty one
		// Every update is an update, never a new conversation turn.
		expect(partials.every((call) => call[6]?.isNonInteractive)).toBe(true)
	})

	it("never lets the bar run backwards when a section is retried", async () => {
		vi.mocked(buildClusterDocument).mockImplementation(async (_creds, _request, onProgress) => {
			onProgress?.({ percent: 42, stage: "section", message: "Wrote section 5 of 9" })
			await settle()
			onProgress?.({ percent: 35, stage: "retry", message: "Section 5 of 9 came back unusable" })
			await settle()
			return Buffer.alloc(10, 1)
		})

		await run({ path: "a.docx", source: null, title: null, author: null }, task, callbacks)

		const percentages = task.say.mock.calls
			.filter((call) => call[0] === "text" && call[3] === true)
			.map((call) => Number(/\*\*(\d+)%\*\*/.exec(String(call[1]))?.[1] ?? 0))
		expect(percentages).toEqual([...percentages].sort((a, b) => a - b))
	})

	it("settles the bar when the cluster fails, instead of leaving it mid-stroke", async () => {
		vi.mocked(buildClusterDocument).mockRejectedValue(new Error("the cluster is down"))
		await run({ path: "a.docx", source: null, title: null, author: null }, task, callbacks)

		const said = task.say.mock.calls.filter((call) => call[0] === "text")
		expect(said.at(-1)?.[3]).toBe(false)
		expect(String(said.at(-1)?.[1])).toContain("the cluster is down")
	})
})
