import axios from "axios"
import { z } from "zod"

import { aiClusterOrigin } from "../../api/providers/fetchers/ai-cluster"

/**
 * The cluster's non-inference surfaces: the skills it has installed, and what
 * the deployment says it can do. Both live on the same host as /v1/chat, which
 * is the whole reason this integration needs no second address.
 */

const skillFileSchema = z.object({
	path: z.string(),
	bytes: z.number().optional(),
	// Text files come inline; anything binary or oversized arrives as a path
	// only and has to be fetched separately.
	text: z.string().optional(),
})

const skillSummarySchema = z.object({
	name: z.string(),
	dirname: z.string().optional(),
	description: z.string().default(""),
	triggers: z.string().optional(),
	runs_on: z.string().optional(),
	digest: z.string().optional(),
	files: z.array(skillFileSchema).default([]),
})

const skillDetailSchema = skillSummarySchema.extend({
	content: z.string(),
})

const skillListSchema = z.object({
	data: z.array(skillSummarySchema),
	skills_dir: z.string().optional(),
	count: z.number().optional(),
})

export type ClusterSkillSummary = z.infer<typeof skillSummarySchema>
export type ClusterSkillDetail = z.infer<typeof skillDetailSchema>

export type ClusterCredentials = {
	baseUrl: string
	apiKey?: string
}

const headers = (apiKey?: string): Record<string, string> => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {})

/** `http://host:18080/v1` → `http://host:18080/mcp`. */
export const aiClusterMcpUrl = (baseUrl: string): string => `${aiClusterOrigin(baseUrl)}/mcp`

/**
 * Skills installed on the cluster.
 *
 * Throws on failure, unlike the model fetcher: a sync is something the user
 * asked for (or that runs on a schedule and reports), so silence would leave
 * them staring at an empty list with no reason for it.
 */
export async function fetchClusterSkills({ baseUrl, apiKey }: ClusterCredentials): Promise<ClusterSkillSummary[]> {
	const response = await axios.get(`${aiClusterOrigin(baseUrl)}/v1/skills`, {
		headers: headers(apiKey),
		timeout: 15_000,
	})
	return skillListSchema.parse(response.data).data
}

export async function fetchClusterSkill(
	{ baseUrl, apiKey }: ClusterCredentials,
	name: string,
): Promise<ClusterSkillDetail> {
	const response = await axios.get(`${aiClusterOrigin(baseUrl)}/v1/skills/${encodeURIComponent(name)}`, {
		headers: headers(apiKey),
		timeout: 30_000,
	})
	return skillDetailSchema.parse(response.data)
}

export type ClusterDocumentRequest = {
	brief?: string
	spec?: Record<string, unknown>
	format: "pdf" | "docx" | "pptx"
	appendBlocks?: Array<Record<string, unknown>>
	lang?: string
	title?: string
	author?: string
	org?: string
	date?: string
	deck?: boolean
	timeoutMs?: number
}

/**
 * Build a document on the cluster and return its bytes.
 *
 * `?download=1` so the reply is the file itself rather than JSON carrying
 * base64: the caller is writing it to disk, and a link the user has to fetch by
 * hand is the step this exists to remove.
 *
 * The format lives in the path rather than the body. A JSON field a model reads
 * as optional gets dropped, and the cluster then defaults to PDF — which is how
 * a PDF ends up saved as .docx and reported by Word as corrupt.
 */
export async function buildClusterDocument(
	{ baseUrl, apiKey }: ClusterCredentials,
	request: ClusterDocumentRequest,
): Promise<Buffer> {
	const body: Record<string, unknown> = {}
	if (request.brief) {
		body.brief = request.brief
	}
	if (request.spec) {
		body.spec = request.spec
	}
	if (request.appendBlocks?.length) {
		body.append_blocks = request.appendBlocks
	}
	for (const key of ["lang", "title", "author", "org", "date"] as const) {
		const value = request[key]
		if (value) {
			body[key] = value
		}
	}
	if (request.deck) {
		body.deck = true
	}

	const response = await axios.post(`${aiClusterOrigin(baseUrl)}/v1/documents/${request.format}?download=1`, body, {
		headers: { ...headers(apiKey), "Content-Type": "application/json" },
		responseType: "arraybuffer",
		// A long document is planned and then written a section at a time,
		// which is minutes of work rather than seconds.
		timeout: request.timeoutMs ?? 30 * 60_000,
		// A refusal arrives as 400 with an explanation worth showing, so it
		// is read here instead of thrown as a bare "Request failed".
		validateStatus: () => true,
		maxContentLength: 128 * 1024 * 1024,
		maxBodyLength: 128 * 1024 * 1024,
	})

	const buffer = Buffer.from(response.data)
	if (response.status >= 400) {
		let message = `the cluster refused the request (HTTP ${response.status})`
		// For ?download=1 a refusal comes back as a rendered document explaining
		// itself — readable by whoever opens it, useless to a program. The same
		// reason is repeated in a header for exactly this reason.
		const header = response.headers?.["x-document-refused"]
		if (typeof header === "string" && header.trim()) {
			message = header.trim()
		} else {
			try {
				const parsed = JSON.parse(buffer.toString("utf8"))
				message = parsed?.error?.message ?? message
			} catch {
				message += ", and returned an explanation in place of the document"
			}
		}
		throw new Error(message)
	}
	if (!buffer.length) {
		throw new Error("the cluster returned an empty document")
	}
	return buffer
}

/** One bundled file the list did not inline (binary, or over the size limit). */
export async function fetchClusterSkillFile(
	{ baseUrl, apiKey }: ClusterCredentials,
	name: string,
	filePath: string,
): Promise<Buffer> {
	const encoded = filePath
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/")
	const response = await axios.get(
		`${aiClusterOrigin(baseUrl)}/v1/skills/${encodeURIComponent(name)}/files/${encoded}`,
		{ headers: headers(apiKey), responseType: "arraybuffer", timeout: 30_000 },
	)
	return Buffer.from(response.data)
}
