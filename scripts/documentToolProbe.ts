/**
 * Run the document tool itself — not just its cluster client — outside VS Code.
 *
 * `clusterProgressProbe` proves the wire; this proves the tool: the workspace
 * walk, the bar, the file that lands on disk, the sentence the model is handed
 * back. Everything except the webview drawing the row, which the e2e test
 * covers in a real VS Code.
 *
 *     npx esbuild scripts/documentToolProbe.ts --bundle --platform=node \
 *         --alias:vscode=./scripts/vscode-stub.js --outfile=toolprobe.cjs
 *     node toolprobe.cjs <project-dir> <http://cluster:18080/v1> [out.docx]
 */
import * as os from "os"
import * as path from "path"

import { documentProjectTool } from "../src/core/tools/DocumentProjectTool"
import type { Task } from "../src/core/task/Task"
import type { ToolCallbacks } from "../src/core/tools/BaseTool"

/** What the chat row would show, one line per repaint. */
function paint(text: string, partial: boolean) {
	const bar = text.split("\n").pop() ?? text
	console.log(`${partial ? "  " : "* "}${bar.replace(/`/g, "")}`)
}

async function main() {
	const [source, baseUrl, out = "manual.docx"] = process.argv.slice(2)
	if (!source || !baseUrl) {
		console.error("usage: node toolprobe.cjs <project-dir> <cluster base url> [out.docx]")
		process.exit(2)
	}

	const cwd = await import("fs/promises").then((fs) => fs.mkdtemp(path.join(os.tmpdir(), "viracode-document-")))
	console.log(`workspace: ${cwd}`)
	console.log(`source:    ${source}`)

	const task = {
		cwd,
		consecutiveMistakeCount: 0,
		didEditFile: false,
		didToolFailInCurrentTurn: false,
		recordToolError: () => {},
		sayAndCreateMissingParamError: async () => "missing parameter",
		say: async (type: string, text?: string, _images?: unknown, partial?: boolean) => {
			if (type === "text" && text) {
				paint(text, !!partial)
			} else if (type === "error") {
				console.error(`ERROR: ${text}`)
			}
		},
		fileContextTracker: { trackFileContext: async () => {} },
		rooIgnoreController: { validateAccess: () => true },
		rooProtectedController: { isWriteProtected: () => false },
		providerRef: {
			deref: () => ({
				getState: async () => ({
					apiConfiguration: { apiProvider: "ai-cluster", aiClusterBaseUrl: baseUrl },
				}),
			}),
		},
	}

	const callbacks = {
		askApproval: async () => true,
		handleError: async (action: string, error: Error) => console.error(`handleError(${action})`, error),
		pushToolResult: (result: unknown) => console.log(`\nresult: ${String(result).slice(0, 400)}`),
	}

	const started = Date.now()
	await documentProjectTool.execute(
		{ path: out, source, title: null, author: null },
		task as unknown as Task,
		callbacks as unknown as ToolCallbacks,
	)
	console.log(`\n${Math.round((Date.now() - started) / 1000)}s total; document at ${path.join(cwd, out)}`)
}

main().catch((error) => {
	console.error("FAILED:", error instanceof Error ? error.message : error)
	process.exit(1)
})
