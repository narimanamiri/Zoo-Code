import fs from "fs/promises"
import path from "path"

import axios from "axios"

/**
 * Turn a link to a document the cluster built into the document itself.
 *
 * The cluster's document tools answer with a URL under /v1/files/<token>/<name>,
 * because an MCP result is text and a file cannot travel in one. That leaves the
 * user with an errand: read the sentence, find the link, click it, choose a
 * folder — for every document, every time. The extension is already running on
 * the machine the file belongs on, so it fetches them here instead and says
 * where they landed.
 *
 * Deliberately quiet about failure. A download that does not work must not turn
 * a successful build into a failed tool call: the link still works by hand, and
 * the message says so.
 */

/** Documents built by this cluster, wherever they are mentioned. */
const FILE_URL = /https?:\/\/[^\s"'<>)\]]+\/v1\/files\/[0-9a-f]+\/[^\s"'<>)\]]+/g

/** Where saved documents go when the caller has no better idea. */
export const DEFAULT_DOCUMENT_DIRNAME = "documents"

export type SavedDocument = { url: string; name: string; relativePath: string; bytes: number }

const filenameFrom = (url: string): string => {
	const last = url.split("/").pop() || "document"
	let decoded = last
	try {
		decoded = decodeURIComponent(last)
	} catch {
		// A name that is not valid percent-encoding is still a usable name.
	}
	// The link is quoted in prose, so it collects trailing punctuation; and a
	// name from a URL must never be able to climb out of the directory.
	return path.basename(decoded.replace(/[.,;:)\]]+$/, "")) || "document"
}

/** Every distinct cluster document link in a piece of text, in order. */
export function documentLinks(text: string): Array<{ url: string; name: string }> {
	const seen = new Set<string>()
	const out: Array<{ url: string; name: string }> = []
	for (const match of String(text ?? "").match(FILE_URL) ?? []) {
		const url = match.replace(/[.,;:)\]]+$/, "")
		if (seen.has(url)) {
			continue
		}
		seen.add(url)
		out.push({ url, name: filenameFrom(url) })
	}
	return out
}

/**
 * Fetch each document into the workspace.
 *
 * Names collide — every "read this and document it" produces `report.docx` —
 * so an existing file is never overwritten silently; the second one becomes
 * `report-2.docx`.
 */
export async function saveDocuments(
	text: string,
	cwd: string,
	options: { directory?: string; apiKey?: string } = {},
): Promise<{ saved: SavedDocument[]; failed: Array<{ url: string; error: string }> }> {
	const links = documentLinks(text)
	const saved: SavedDocument[] = []
	const failed: Array<{ url: string; error: string }> = []
	if (!links.length) {
		return { saved, failed }
	}

	const directory = options.directory ?? DEFAULT_DOCUMENT_DIRNAME
	const targetDir = path.resolve(cwd, directory)

	for (const link of links) {
		try {
			const response = await axios.get(link.url, {
				responseType: "arraybuffer",
				timeout: 120_000,
				headers: options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : undefined,
				maxContentLength: 128 * 1024 * 1024,
			})
			const buffer = Buffer.from(response.data)
			if (!buffer.length) {
				failed.push({ url: link.url, error: "the server returned an empty file" })
				continue
			}

			await fs.mkdir(targetDir, { recursive: true })
			const extension = path.extname(link.name)
			const stem = extension ? link.name.slice(0, -extension.length) : link.name
			let candidate = link.name
			for (let n = 2; n < 100; n++) {
				try {
					await fs.access(path.join(targetDir, candidate))
					candidate = `${stem}-${n}${extension}`
				} catch {
					break
				}
			}

			await fs.writeFile(path.join(targetDir, candidate), buffer)
			saved.push({
				url: link.url,
				name: candidate,
				relativePath: path.join(directory, candidate).split(path.sep).join("/"),
				bytes: buffer.length,
			})
		} catch (error) {
			failed.push({ url: link.url, error: error instanceof Error ? error.message : String(error) })
		}
	}

	return { saved, failed }
}

/** What to add to the tool result, so the model reports a path and not a link. */
export function deliveryNote(saved: SavedDocument[], failed: Array<{ url: string; error: string }>): string {
	const lines: string[] = []
	for (const document of saved) {
		lines.push(
			`Saved to the workspace: ${document.relativePath} (${Math.round(document.bytes / 1024)} KB). ` +
				`Tell the user this path — the file is already downloaded, and the link does not need to be opened.`,
		)
	}
	for (const failure of failed) {
		lines.push(`Could not download ${failure.url} automatically (${failure.error}); the link still works.`)
	}
	return lines.join("\n")
}
