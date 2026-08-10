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

	it("says what to do when the profile is not an AI Cluster", async () => {
		task.providerRef = {
			deref: () => ({ getState: vi.fn().mockResolvedValue({ apiConfiguration: { apiProvider: "openai" } }) }),
		}
		await run({ path: "a.docx", source: null, title: null, author: null }, task, callbacks)

		expect(vi.mocked(buildClusterDocument)).not.toHaveBeenCalled()
		expect(resultOf(callbacks)).toContain("AI Cluster profile")
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
})
