import fs from "fs/promises"
import os from "os"
import path from "path"

import { describe, it, expect, beforeAll, afterAll } from "vitest"

import {
	dependencyDiagram,
	digestRepository,
	digestToBlocks,
	digestToBrief,
	headerComment,
	importEdges,
	moduleName,
} from "../repoDigest"

/**
 * The digest is the whole reason document_project produces a document rather
 * than four lines of prose, so what it does and does not read is the thing
 * worth pinning down.
 */

let root: string

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "digest-"))
	const write = async (relative: string, content: string) => {
		const full = path.join(root, relative)
		await fs.mkdir(path.dirname(full), { recursive: true })
		await fs.writeFile(full, content, "utf8")
	}

	await write("README.md", "# Sample\n\nA project that exists to be read.\n")
	await write(
		"src/server.py",
		'"""The HTTP surface, and the only place a request is parsed."""\n\n' +
			"import os\n\n\ndef serve(port):\n    return port\n\n\nclass Router:\n    pass\n\n\ndef _private():\n    pass\n",
	)
	await write(
		"src/client.ts",
		"// Talks to the server, and retries once when it does not answer.\n\n" +
			"export function connect(url: string) {\n\treturn url\n}\n\n" +
			"export class Session {}\n\nexport interface Options {}\n",
	)
	await write(
		"src/util.go",
		"// Small helpers nobody else wanted.\npackage util\n\nfunc Trim(s string) string {\n\treturn s\n}\n",
	)
	// Everything below must be skipped: dependencies, build output, binaries.
	await write("node_modules/left-pad/index.js", "module.exports = 1\n")
	await write("dist/bundle.js", "console.log(1)\n")
	await write(".git/config", "[core]\n")
	await fs.writeFile(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))
	await fs.writeFile(path.join(root, "src", "blob.txt"), Buffer.from([0x41, 0x00, 0x42, 0x00]))
})

afterAll(async () => {
	await fs.rm(root, { recursive: true, force: true })
})

describe("digestRepository", () => {
	it("reads the project and nothing that belongs to someone else", async () => {
		const digest = await digestRepository(root)
		const paths = digest.files.map((f) => f.path)

		expect(paths).toContain("src/server.py")
		expect(paths).toContain("src/client.ts")
		expect(paths).toContain("README.md")
		expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false)
		expect(paths.some((p) => p.startsWith("dist/"))).toBe(false)
		expect(paths.some((p) => p.startsWith(".git/"))).toBe(false)
		expect(paths).not.toContain("logo.png")
		// A .txt full of NUL bytes is a binary somebody misnamed.
		expect(paths).not.toContain("src/blob.txt")
	})

	it("takes each file's own statement of purpose rather than composing one", async () => {
		const digest = await digestRepository(root)
		const server = digest.files.find((f) => f.path === "src/server.py")
		const client = digest.files.find((f) => f.path === "src/client.ts")

		expect(server?.purpose).toBe("The HTTP surface, and the only place a request is parsed.")
		expect(client?.purpose).toBe("Talks to the server, and retries once when it does not answer.")
	})

	it("names what each file defines, and leaves the private ones out", async () => {
		const digest = await digestRepository(root)
		const server = digest.files.find((f) => f.path === "src/server.py")
		const client = digest.files.find((f) => f.path === "src/client.ts")
		const util = digest.files.find((f) => f.path === "src/util.go")

		expect(server?.defines).toEqual(["serve", "Router"])
		expect(client?.defines).toEqual(expect.arrayContaining(["connect", "Session", "Options"]))
		expect(util?.defines).toEqual(["Trim"])
	})

	it("counts by directory, largest first", async () => {
		const digest = await digestRepository(root)
		expect(digest.directories[0].name).toBe("src")
		expect(digest.fileCount).toBeGreaterThanOrEqual(4)
		expect(digest.totalLines).toBeGreaterThan(0)
	})

	it("quotes the README whole, because it is the answer to what this is", async () => {
		const digest = await digestRepository(root)
		expect(digest.configs.map((c) => c.path)).toContain("README.md")
		expect(digest.configs.find((c) => c.path === "README.md")?.text).toContain("A project that exists to be read")
	})

	it("stops at the file limit instead of walking forever", async () => {
		const digest = await digestRepository(root, 2)
		expect(digest.truncated).toBe(true)
		expect(digest.files.length).toBe(2)
	})
})

describe("digestToBrief", () => {
	it("carries the real names, and says not to invent any others", async () => {
		const brief = digestToBrief(await digestRepository(root))
		expect(brief).toContain("src/server.py")
		expect(brief).toContain("The HTTP surface")
		expect(brief).toContain("COMPONENTS")
		expect(brief).toContain("Do not name a file, command, framework or setting that is not listed")
	})

	it("spends a small budget on the largest files rather than the alphabet", async () => {
		const digest = await digestRepository(root)
		const brief = digestToBrief(digest, 1_200)
		expect(brief.length).toBeLessThan(4_000)
		expect(brief).toContain("smaller files omitted for length")
	})
})

describe("imports", () => {
	it("finds what a Python package imports from itself", () => {
		// `from . import build, charts` names its siblings in the import list,
		// which is how most packages import themselves.
		const files = ["pkg/agent.py", "pkg/build.py", "pkg/charts.py", "pkg/spec.py"].map((p) => ({
			path: p,
			lines: 1,
			purpose: "",
			defines: [],
		}))
		const texts = new Map([
			["pkg/agent.py", "from . import build, charts\nfrom .spec import prepare\n"],
			["pkg/charts.py", "from . import spec\n"],
		])
		const edges = importEdges(files, texts)
		expect(edges).toEqual(
			expect.arrayContaining([
				{ from: "pkg/agent", to: "pkg/build" },
				{ from: "pkg/agent", to: "pkg/charts" },
				{ from: "pkg/agent", to: "pkg/spec" },
				{ from: "pkg/charts", to: "pkg/spec" },
			]),
		)
	})

	it("resolves a relative TypeScript import to the file it names", () => {
		const files = ["src/tool.ts", "src/services/client.ts"].map((p) => ({
			path: p,
			lines: 1,
			purpose: "",
			defines: [],
		}))
		const texts = new Map([["src/tool.ts", 'import { build } from "../services/client"' + String.fromCharCode(10)]])
		expect(importEdges(files, texts)).toEqual([{ from: "src/tool", to: "src/services/client" }])
	})

	it("leaves third-party packages out", () => {
		const files = [{ path: "a.py", lines: 1, purpose: "", defines: [] }]
		const texts = new Map([["a.py", "import os\nimport requests\nfrom django.db import models\n"]])
		expect(importEdges(files, texts)).toEqual([])
	})

	it("knows what a file is called inside its own project", () => {
		expect(moduleName("pkg/__init__.py")).toBe("pkg")
		expect(moduleName("src/services/index.ts")).toBe("src/services")
		expect(moduleName("a/b.py")).toBe("a/b")
	})
})

describe("dependencyDiagram", () => {
	it("draws the modules with the most connections", async () => {
		const digest = await digestRepository(root)
		const diagram = dependencyDiagram({
			...digest,
			imports: [
				{ from: "a", to: "b" },
				{ from: "a", to: "c" },
				{ from: "b", to: "c" },
			],
		}) as { diagram: string; nodes: Array<{ id: string }>; edges: unknown[] }
		expect(diagram.diagram).toBe("graph")
		expect(diagram.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"])
		expect(diagram.edges).toHaveLength(3)
	})

	it("says nothing rather than drawing a graph of one arrow", async () => {
		const digest = await digestRepository(root)
		expect(dependencyDiagram({ ...digest, imports: [{ from: "a", to: "b" }] })).toBeNull()
	})
})

describe("digestToBlocks", () => {
	it("hands over the inventory and a diagram of the modules, as facts to typeset", async () => {
		const digest = await digestRepository(root)
		const blocks = digestToBlocks({
			...digest,
			imports: [
				{ from: "src/server", to: "src/client" },
				{ from: "src/client", to: "src/util" },
			],
		})
		const types = blocks.map((b) => b.type)
		// A code document needs a module map, not a bar chart of line counts.
		expect(types).toContain("diagram")
		expect(types).not.toContain("chart")
		expect(types).toContain("table")

		const table = blocks.find((b) => b.type === "table") as { header: string[]; rows: string[][] }
		expect(table.header).toEqual(["File", "Lines", "Purpose"])
		expect(table.rows.length).toBeGreaterThan(0)
		expect(table.rows.every((row) => row.length === 3)).toBe(true)
	})
})

describe("headerComment", () => {
	it("reads a block comment and stops at the code", () => {
		const text = "/*\n * One thing this file does.\n */\nconst x = 1 // not this\n"
		expect(headerComment(text, ".ts")).toBe("One thing this file does.")
	})

	it("returns nothing rather than guessing when a file says nothing", () => {
		expect(headerComment("const x = 1\n", ".ts")).toBe("")
	})
})

describe("usage surface", () => {
	/**
	 * The gap this covers cost a real document its manual: the extension's digest
	 * described every module of a project whose server has three flags and two
	 * endpoints, and the brief mentioned none of them — so the cluster had
	 * nothing to write the user-manual sections from.
	 */
	let usageRoot: string

	beforeAll(async () => {
		usageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "digest-usage-"))
		const write = async (relative: string, content: string) => {
			const full = path.join(usageRoot, relative)
			await fs.mkdir(path.dirname(full), { recursive: true })
			await fs.writeFile(full, content, "utf8")
		}
		await write(
			"serve.py",
			[
				'"""Minimal OpenAI-compatible server."""',
				"import argparse, os",
				"from fastapi import FastAPI",
				"app = FastAPI()",
				"PORT = int(os.environ.get('SERVE_PORT', '1236'))",
				"KEY = os.getenv('SERVE_KEY')",
				'@app.get("/v1/models")',
				"def models():",
				"    return []",
				'@app.post("/v1/chat/completions")',
				"def chat(req):",
				"    return {}",
				"def main():",
				"    ap = argparse.ArgumentParser()",
				"    ap.add_argument('--base', help='base model to load')",
				"    ap.add_argument('--port', help='port to listen on')",
				"    return ap.parse_args()",
				"if __name__ == '__main__':",
				"    main()",
			].join("\n"),
		)
		await write("package.json", JSON.stringify({ name: "depot", scripts: { start: "node serve.js" } }))
	})

	afterAll(async () => {
		await fs.rm(usageRoot, { recursive: true, force: true })
	})

	it("finds the entry point, the flags, the endpoints and the settings", async () => {
		const digest = await digestRepository(usageRoot)

		expect(digest.usage.entryPoints.map((entry) => entry.path)).toContain("serve.py")
		const flags = digest.usage.commands.flatMap((file) => file.flags.map((flag) => flag.name))
		expect(flags).toEqual(expect.arrayContaining(["--base", "--port"]))
		expect(digest.usage.commands.flatMap((file) => file.commands.map((c) => c.name))).toContain("npm run start")

		const routes = digest.usage.routes.map((route) => `${route.method} ${route.path}`)
		expect(routes).toEqual(expect.arrayContaining(["GET /v1/models", "POST /v1/chat/completions"]))

		const settings = Object.fromEntries(digest.usage.env.map((entry) => [entry.name, entry.default]))
		expect(settings).toHaveProperty("SERVE_PORT", "1236")
		expect(settings).toHaveProperty("SERVE_KEY")
	})

	it("puts it in the brief under the headings the cluster looks for", async () => {
		const brief = digestToBrief(await digestRepository(usageRoot))

		// The cluster keys its user-manual sections off this exact heading.
		expect(brief).toContain("HOW THE PROJECT IS RUN AND WHAT IT ACCEPTS")
		expect(brief).toContain("COMMANDS AND OPTIONS")
		expect(brief).toContain("HTTP ENDPOINTS SERVED")
		expect(brief).toContain("ENVIRONMENT VARIABLES READ")
		expect(brief).toContain("option --base — base model to load")
		expect(brief).toContain("/v1/chat/completions")
		expect(brief).toContain("SERVE_PORT")
		// And the closing instruction asks for the manual, counting what it has.
		expect(brief).toMatch(/user-manual sections have to account for all of them/)
	})

	it("says nothing at all about usage when the project offers none", async () => {
		const quiet = await fs.mkdtemp(path.join(os.tmpdir(), "digest-quiet-"))
		try {
			await fs.writeFile(path.join(quiet, "lib.py"), '"""A library."""\ndef helper():\n    return 1\n', "utf8")
			const brief = digestToBrief(await digestRepository(quiet))
			expect(brief).not.toContain("HOW THE PROJECT IS RUN")
			expect(brief).toContain("lists no commands or endpoints")
		} finally {
			await fs.rm(quiet, { recursive: true, force: true })
		}
	})
})
