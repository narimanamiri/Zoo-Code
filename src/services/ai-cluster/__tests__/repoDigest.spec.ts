import fs from "fs/promises"
import os from "os"
import path from "path"

import { describe, it, expect, beforeAll, afterAll } from "vitest"

import { digestRepository, digestToBlocks, digestToBrief, headerComment } from "../repoDigest"

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

describe("digestToBlocks", () => {
	it("hands over the inventory and a chart of it, as facts to typeset", async () => {
		const blocks = digestToBlocks(await digestRepository(root))
		const types = blocks.map((b) => b.type)
		expect(types).toContain("chart")
		expect(types).toContain("table")

		const chart = blocks.find((b) => b.type === "chart") as { values: number[]; labels: string[] }
		expect(chart.values.every((v) => typeof v === "number")).toBe(true)
		expect(chart.labels).not.toContain(".")

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
