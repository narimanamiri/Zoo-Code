/**
 * Drive the document tool's own cluster client against a real cluster, and draw
 * the bar it would draw.
 *
 * The unit tests prove the parsing; this proves the wire. Bundle it and run it
 * from a machine that can reach the cluster:
 *
 *     npx esbuild scripts/clusterProgressProbe.ts --bundle --platform=node \
 *         --outfile=probe.cjs
 *     node probe.cjs <project-dir> <http://cluster:18080/v1> [docx|pdf|pptx]
 */
import { buildClusterDocument } from "../src/services/ai-cluster/client"
import { digestRepository, digestToBlocks, digestToBrief } from "../src/services/ai-cluster/repoDigest"

const BAR_CELLS = 24

const bar = (percent: number) => {
	const filled = Math.round((BAR_CELLS * percent) / 100)
	return "█".repeat(filled) + "░".repeat(BAR_CELLS - filled)
}

async function main() {
	const [root, baseUrl, format = "docx"] = process.argv.slice(2)
	if (!root || !baseUrl) {
		console.error("usage: node probe.cjs <project-dir> <cluster base url> [docx|pdf|pptx]")
		process.exit(2)
	}

	const started = Date.now()
	const digest = await digestRepository(root)
	console.log(`read ${digest.fileCount} files, ${digest.totalLines} lines from ${root}`)

	const buffer = await buildClusterDocument(
		{ baseUrl },
		{
			format: format as "docx" | "pdf" | "pptx",
			brief: digestToBrief(digest),
			appendBlocks: format === "pptx" ? undefined : digestToBlocks(digest),
			deck: format === "pptx",
		},
		(event) => {
			const seconds = Math.round((Date.now() - started) / 1000)
			console.log(
				`${String(seconds).padStart(4)}s  ${bar(event.percent)} ${String(event.percent).padStart(3)}%  ${event.message}`,
			)
		},
	)
	console.log(`document: ${buffer.length} bytes in ${Math.round((Date.now() - started) / 1000)}s`)
}

main().catch((error) => {
	console.error("FAILED:", error instanceof Error ? error.message : error)
	process.exit(1)
})
