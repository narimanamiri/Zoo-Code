import fs from "fs/promises"
import path from "path"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { buildClusterDocument } from "../../services/ai-cluster/client"
import { documentCredentials } from "../../services/ai-cluster"
import { digestRepository, digestToBlocks, digestToBrief } from "../../services/ai-cluster/repoDigest"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { DocumentProjectParams, ToolUse } from "../../shared/tools"

/**
 * Document a codebase by reading it, rather than by remembering it.
 *
 * Asked to "read all the code and write full documentation", the model opened
 * two files out of a hundred and produced four lines of prose naming a
 * component that does not exist. Every attempt to fix that with instructions
 * failed the same way: the context is small, the repository is not, and the
 * gap gets filled from what such projects usually contain.
 *
 * So neither half of the job is left to the model. The extension walks the
 * workspace and sends the cluster what is actually in it — every file's own
 * header comment, its definitions, its size — and writes the finished document
 * straight into the workspace. The model's part is choosing to call this, which
 * is the one thing tool calling is reliable at.
 */
export class DocumentProjectTool extends BaseTool<"document_project"> {
	readonly name = "document_project" as const

	async execute(params: DocumentProjectParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { handleError, pushToolResult, askApproval } = callbacks
		const relPath = params.path?.trim()

		if (!relPath) {
			task.consecutiveMistakeCount++
			task.recordToolError("document_project")
			pushToolResult(await task.sayAndCreateMissingParamError("document_project", "path"))
			return
		}

		const format = (path.extname(relPath).slice(1).toLowerCase() || "docx") as "pdf" | "docx" | "pptx"
		if (!["pdf", "docx", "pptx"].includes(format)) {
			task.consecutiveMistakeCount++
			task.recordToolError("document_project")
			pushToolResult(
				formatResponse.toolError(
					`Unsupported document format ".${format}". End the path in .docx, .pdf or .pptx.`,
				),
			)
			return
		}

		const provider = task.providerRef.deref()
		const credentials = documentCredentials((await provider?.getState())?.apiConfiguration)
		if (!credentials) {
			// Only when the profile names no address at all — a hosted provider
			// like Anthropic or OpenAI proper. Said plainly, because the
			// alternative the model reaches for is writing the document itself.
			pushToolResult(
				formatResponse.toolError(
					"document_project builds the document on an AI Cluster, and this profile does not " +
						"point at one — it has no base URL of its own. Switch to the profile that talks " +
						"to your cluster (either the AI Cluster provider or an OpenAI Compatible profile " +
						"pointing at it) and try again. Do not write the document by hand instead: it " +
						"would be a summary of the few files that fit in context, presented as the " +
						"documentation of the whole project.",
				),
			)
			return
		}

		const accessAllowed = task.rooIgnoreController?.validateAccess(relPath)
		if (!accessAllowed) {
			await task.say("rooignore_error", relPath)
			pushToolResult(formatResponse.rooIgnoreError(relPath))
			return
		}

		// Told to leave the author out rather than invent one, the model put
		// itself on the cover. Nobody wants a manual authored by the assistant,
		// and a cover field is exactly where an invented name looks official.
		const author = params.author?.trim()
		const authorIsTheAssistant = !!author && /^(zoo|roo|cline|assistant|ai|the ai)$/i.test(author)

		const sourceRel = params.source?.trim() || "."
		const sourceRoot = path.resolve(task.cwd, sourceRel)
		const absolutePath = path.resolve(task.cwd, relPath)
		const isWriteProtected = task.rooProtectedController?.isWriteProtected(relPath) || false

		try {
			task.consecutiveMistakeCount = 0

			const approval = JSON.stringify({
				tool: "documentProject" as const,
				path: getReadablePath(task.cwd, relPath),
				content: `Read ${getReadablePath(task.cwd, sourceRel)} and write ${format.toUpperCase()} documentation`,
				isOutsideWorkspace: isPathOutsideWorkspace(absolutePath),
				isProtected: isWriteProtected,
			})
			if (!(await askApproval("tool", approval, undefined, isWriteProtected))) {
				return
			}

			const digest = await digestRepository(sourceRoot)
			if (!digest.fileCount) {
				pushToolResult(
					formatResponse.toolError(
						`No source files found under ${getReadablePath(task.cwd, sourceRel)}. Point ` +
							`"source" at the directory holding the code.`,
					),
				)
				return
			}

			await task.say(
				"text",
				`Read ${digest.fileCount} files (${digest.totalLines.toLocaleString("en-US")} lines) from ` +
					`${getReadablePath(task.cwd, sourceRel)}. Writing the document on the cluster — a large ` +
					`project is planned and then written a section at a time, so this takes a few minutes.`,
			)

			const buffer = await buildClusterDocument(credentials, {
				format,
				brief: digestToBrief(digest),
				// A deck has no appendix worth the page, and the cluster refuses
				// to append document blocks to slides.
				appendBlocks: format === "pptx" ? undefined : digestToBlocks(digest),
				title: params.title?.trim() || undefined,
				author: authorIsTheAssistant ? undefined : author || undefined,
				deck: format === "pptx",
			})

			await fs.mkdir(path.dirname(absolutePath), { recursive: true })
			await fs.writeFile(absolutePath, buffer)
			await task.fileContextTracker.trackFileContext(relPath, "roo_edited")
			task.didEditFile = true

			const kb = Math.round(buffer.length / 1024)
			pushToolResult(
				formatResponse.toolResult(
					`Wrote ${getReadablePath(task.cwd, relPath)} — ${kb} KB, built from ${digest.fileCount} ` +
						`files (${digest.totalLines.toLocaleString("en-US")} lines). The document is saved in ` +
						`the workspace; there is nothing to download.`,
				),
			)
		} catch (error) {
			// A refusal from the cluster is a message the user should see whole —
			// it names what was wrong with the request and what to do instead.
			const message = error instanceof Error ? error.message : String(error)
			await task.say("error", `document_project: ${message}`)
			task.didToolFailInCurrentTurn = true
			pushToolResult(formatResponse.toolError(message))
			if (!(error instanceof Error)) {
				await handleError("documenting the project", error as Error)
			}
		}
	}

	override async handlePartial(_task: Task, _block: ToolUse<"document_project">): Promise<void> {
		return
	}
}

export const documentProjectTool = new DocumentProjectTool()
