import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"

import * as vscode from "vscode"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import { waitUntilCompleted } from "./utils"
import { setDefaultSuiteTimeout } from "./test-utils"

/**
 * The document progress bar, in a real VS Code, against a real cluster.
 *
 * The unit tests prove the parsing and the painting; only this proves the thing
 * the user actually sees — that the row updates itself rather than posting a
 * new one per event, and that the percentages arrive while the document is
 * being written rather than all at the end.
 *
 * Needs a cluster: set AI_CLUSTER_URL (e.g. http://127.0.0.1:18080/v1, which
 * can be an ssh tunnel to it). Skipped when that is not set, so the ordinary
 * mocked e2e run is unaffected.
 */
const CLUSTER = process.env.AI_CLUSTER_URL
const CLUSTER_KEY = process.env.AI_CLUSTER_KEY || "clusterkey"

/** A small project, so the cluster has something real to read and describe. */
const FIXTURE: Record<string, string> = {
	"src/server.py":
		'"""HTTP entry point for the parts depot."""\n' +
		"import os\n\n" +
		"PORT = int(os.environ.get('DEPOT_PORT', '8080'))\n\n" +
		"def serve():\n    '''Start the depot API.'''\n    return PORT\n",
	"src/stock.py":
		'"""Stock levels, and what to do when they run low."""\n' +
		"THRESHOLD = 4\n\n" +
		"def below_threshold(counts):\n    return [k for k, v in counts.items() if v < THRESHOLD]\n",
	"src/cli.py":
		'"""Command line for the depot."""\n' +
		"import argparse\n\n" +
		"def main():\n" +
		"    parser = argparse.ArgumentParser()\n" +
		"    sub = parser.add_subparsers()\n" +
		"    sub.add_parser('report', help='print the stock report')\n" +
		"    sub.add_parser('restock', help='order what is below the threshold')\n" +
		"    parser.add_argument('--verbose', help='say what is happening')\n" +
		"    return parser.parse_args()\n\n" +
		"if __name__ == '__main__':\n    main()\n",
	"README.md": "# Parts depot\n\nKeeps stock levels and reorders what runs low.\n",
}

suite("Document progress", function () {
	setDefaultSuiteTimeout(this)
	// A document is planned and then written a section at a time on the cluster.
	// The default suite budget is two minutes, which is shorter than the thing
	// being tested.
	this.timeout(20 * 60_000)

	test("draws a bar that advances in one chat row while the document is written", async function () {
		if (!CLUSTER) {
			this.skip()
		}
		const api = globalThis.api
		const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		assert.ok(workspace, "the e2e runner opens a temporary workspace")

		for (const [rel, body] of Object.entries(FIXTURE)) {
			const target = path.join(workspace!, rel)
			await fs.mkdir(path.dirname(target), { recursive: true })
			await fs.writeFile(target, body, "utf8")
		}

		const painted: ClineMessage[] = []
		const finished: ClineMessage[] = []
		api.on(RooCodeEventName.Message, ({ message }) => {
			if (message.type !== "say" || message.say !== "text" || !message.text?.includes("%")) {
				return
			}
			;(message.partial ? painted : finished).push({ ...message })
			console.log(`[bar ${message.partial ? "partial" : "final"}]`, message.text?.replace(/\n+/g, " | "))
		})

		// The conversation stays on the harness's mocked model — a fixture makes
		// the tool call and signs off — while the document itself is built by a
		// real cluster, which is the half worth testing. `aiClusterBaseUrl` is
		// where documentCredentials looks first, so the two can differ.
		const taskId = await api.startNewTask({
			configuration: {
				mode: "code",
				aiClusterBaseUrl: CLUSTER,
				aiClusterApiKey: CLUSTER_KEY,
				autoApprovalEnabled: true,
				alwaysAllowWrite: true,
				alwaysAllowReadOnly: true,
				alwaysAllowModeSwitch: true,
			},
			text: "DOCUMENT_PROGRESS_SMOKE: document this workspace into docs/manual.docx.",
		})

		await waitUntilCompleted({ api, taskId, timeout: 18 * 60_000 })

		// The bar was drawn, more than once, and reached the end.
		assert.ok(painted.length > 1, `expected several progress updates, got ${painted.length}`)
		const bars = painted.map((message) => String(message.text))
		assert.ok(
			bars.some((text) => text.includes("█")),
			"expected a filled bar cell",
		)

		// One row: every update carries the timestamp of the first one.
		const rows = new Set(painted.map((message) => message.ts))
		assert.strictEqual(rows.size, 1, `expected one chat row, got ${rows.size}`)

		// It never runs backwards, and it finishes.
		const percentages = bars.map((text) => Number(/\*\*(\d+)%\*\*/.exec(text)?.[1] ?? -1))
		assert.deepStrictEqual(
			percentages,
			[...percentages].sort((a, b) => a - b),
			`percentages went backwards: ${percentages.join(", ")}`,
		)
		// The row the user is left looking at shows a finished bar. The last
		// events arrive in a burst as the document lands, so the closing line —
		// not the last partial — is where 100% has to be.
		const closing = String(finished.at(-1)?.text ?? "")
		assert.ok(closing.includes("**100%**"), `the closing row does not show 100%: ${closing}`)

		// The stages are the cluster's, not a timer's. A project this small is
		// written in one pass, so it reports drafts where a large one reports
		// sections; either proves the events came from the writing itself.
		const everything = bars.join("\n")
		assert.ok(
			/section \d+ of \d+|draft \d+ written|typesetting/i.test(everything),
			`expected the cluster's own stages, got:\n${everything}`,
		)

		// And the row settles, so it is not left mid-stroke.
		assert.ok(finished.length >= 1, "expected the progress row to be closed with a final message")

		// The document itself is on disk, and is a real file rather than an error.
		const written = await fs.stat(path.join(workspace!, "docs", "manual.docx"))
		assert.ok(written.size > 20_000, `expected a real document, got ${written.size} bytes`)
	})
})
