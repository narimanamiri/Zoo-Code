import fs from "fs/promises"
import path from "path"

/**
 * Read a project so a model does not have to remember it.
 *
 * Asked to "read this codebase and document it", a model opens two or three
 * files out of a hundred and writes the rest of the document from the directory
 * listing — measured on the cluster's own repository, it produced four lines of
 * prose and a component that does not exist. That is not a prompting problem:
 * the context is small, the repository is not, and anything unread gets filled
 * in from what such projects usually contain.
 *
 * The extension is the one part of this system that can read the whole
 * workspace, so the reading happens here. What it extracts is deliberately
 * shallow and complete rather than deep and selective: every file contributes
 * its own header comment, its definitions and its size, and nothing gets a
 * summary invented for it.
 *
 * Mirrors tools/repo_digest/repo_digest.py in the cluster repository — the two
 * exist because the work has to happen wherever the code is, and the code is
 * sometimes on a laptop the cluster cannot see.
 */

/** Directories that belong to somebody else: dependencies, build output, caches. */
const SKIP_DIRS = new Set([
	".git",
	".hg",
	".svn",
	".idea",
	".vscode",
	"__pycache__",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	"node_modules",
	"venv",
	".venv",
	"env",
	"dist",
	"build",
	"target",
	"out",
	".next",
	".nuxt",
	"coverage",
	".tox",
	"site-packages",
	".gradle",
	"vendor",
	".terraform",
	"bower_components",
	".turbo",
	".changeset",
])

const SKIP_SUFFIXES = [
	".pyc",
	".pyo",
	".so",
	".dll",
	".dylib",
	".exe",
	".bin",
	".o",
	".a",
	".zip",
	".gz",
	".tgz",
	".xz",
	".bz2",
	".7z",
	".rar",
	".jar",
	".war",
	".png",
	".jpg",
	".jpeg",
	".gif",
	".bmp",
	".ico",
	".svg",
	".webp",
	".pdf",
	".docx",
	".pptx",
	".xlsx",
	".woff",
	".woff2",
	".ttf",
	".otf",
	".mp3",
	".mp4",
	".mov",
	".avi",
	".wav",
	".gguf",
	".safetensors",
	".db",
	".sqlite",
	".sqlite3",
	".lock",
	".map",
	".min.js",
	".min.css",
]

const TEXT_SUFFIXES = [
	".py",
	".js",
	".jsx",
	".ts",
	".tsx",
	".go",
	".rs",
	".java",
	".kt",
	".rb",
	".php",
	".c",
	".h",
	".cc",
	".cpp",
	".hpp",
	".cs",
	".swift",
	".scala",
	".sh",
	".bash",
	".zsh",
	".ps1",
	".sql",
	".r",
	".lua",
	".pl",
	".md",
	".rst",
	".txt",
	".yaml",
	".yml",
	".toml",
	".ini",
	".cfg",
	".json",
	".html",
	".css",
	".scss",
	".vue",
	".svelte",
	".tf",
	".proto",
	".typ",
]

/** Files worth quoting whole: they *are* the answer to "how is this configured". */
const CONFIG_NAMES = new Set([
	"readme.md",
	"readme.rst",
	"readme.txt",
	"readme",
	"pyproject.toml",
	"setup.py",
	"setup.cfg",
	"requirements.txt",
	"package.json",
	"cargo.toml",
	"go.mod",
	"pom.xml",
	"build.gradle",
	"dockerfile",
	"docker-compose.yml",
	"docker-compose.yaml",
	"makefile",
	"justfile",
	"taskfile.yml",
	".env.example",
	"config.yaml",
	"config.yml",
	"config.json",
	"claude.md",
	"agents.md",
	"contributing.md",
	"tsconfig.json",
])

const CONFIG_MAX = 6_000
const READ_LIMIT = 400_000

/** One pattern per language family: naming what exists, not parsing scope. */
const DEFINITION_PATTERNS: Array<{ suffixes: string[]; pattern: RegExp }> = [
	{ suffixes: [".py", ".pyi"], pattern: /^(?:async\s+)?(?:def|class)\s+(\w+)/gm },
	{
		suffixes: [".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte"],
		pattern:
			/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s+(\w+)|class\s+(\w+)|interface\s+(\w+)|type\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?[({])/gm,
	},
	{ suffixes: [".go"], pattern: /^func\s+(?:\([^)]*\)\s*)?(\w+)/gm },
	{ suffixes: [".rs"], pattern: /^\s*(?:pub\s+)?(?:async\s+)?(?:fn|struct|enum|trait)\s+(\w+)/gm },
	{
		suffixes: [".java", ".kt", ".cs", ".scala"],
		pattern:
			/^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:class|interface|object|record|enum)\s+(\w+)/gm,
	},
	{ suffixes: [".rb"], pattern: /^\s*(?:def|class|module)\s+([\w.]+)/gm },
	{ suffixes: [".sh", ".bash", ".zsh"], pattern: /^(?:function\s+)?(\w+)\s*\(\)\s*\{/gm },
]

export type DigestFile = {
	path: string
	lines: number
	purpose: string
	defines: string[]
}

export type DigestDirectory = {
	name: string
	files: number
	lines: number
}

export type RepoDigest = {
	name: string
	root: string
	fileCount: number
	totalLines: number
	truncated: boolean
	directories: DigestDirectory[]
	files: DigestFile[]
	configs: Array<{ path: string; text: string; clipped: boolean }>
}

/** Blocks the caller already holds as fact, typeset verbatim by the cluster. */
export type SpecBlock = Record<string, unknown>

const endsWithAny = (name: string, suffixes: string[]): boolean => suffixes.some((s) => name.endsWith(s))

const definitionPattern = (suffix: string): RegExp | undefined =>
	DEFINITION_PATTERNS.find((entry) => entry.suffixes.includes(suffix))?.pattern

/**
 * The file's own statement of purpose: docstring, or leading comment block.
 *
 * Preferring what the author wrote over anything generated is the whole point —
 * it is the one description in the file guaranteed not to be a guess.
 */
export function headerComment(text: string, suffix: string): string {
	if (suffix === ".py" || suffix === ".pyi") {
		const match = text.match(/^\s*(?:#[^\n]*\n)*\s*(?:"""|''')([\s\S]*?)(?:"""|''')/)
		if (match) {
			return match[1].split(/\s+/).filter(Boolean).join(" ").slice(0, 300)
		}
	}
	const out: string[] = []
	for (const line of text.split("\n").slice(0, 25)) {
		const trimmed = line.trim()
		if (!trimmed) {
			if (out.length) {
				break
			}
			continue
		}
		if (trimmed.startsWith("#!") || trimmed.startsWith("# -*-") || trimmed.startsWith("<?")) {
			continue
		}
		if (/^(#|\/\/|--|;)/.test(trimmed)) {
			out.push(trimmed.replace(/^[#/\-;\s]+/, "").trim())
		} else if (trimmed.startsWith("/*") || trimmed.startsWith("*")) {
			// The closing line of a block comment is "*/", which survives the
			// prefix strip as a lone slash and lands in the middle of the
			// sentence. Nothing on that line is ever the description.
			if (/^\*+\/$/.test(trimmed)) {
				break
			}
			const cleaned = trimmed
				.replace(/^\/\*+/, "")
				.replace(/^\*+/, "")
				.replace(/\*+\/$/, "")
				.trim()
			if (cleaned) {
				out.push(cleaned)
			}
		} else {
			break
		}
		if (out.join(" ").length > 300) {
			break
		}
	}
	return out.join(" ").slice(0, 300)
}

async function readTextFile(fullPath: string): Promise<string | undefined> {
	try {
		const handle = await fs.open(fullPath, "r")
		try {
			const buffer = Buffer.alloc(READ_LIMIT)
			const { bytesRead } = await handle.read(buffer, 0, READ_LIMIT, 0)
			const slice = buffer.subarray(0, bytesRead)
			// A binary we did not recognise by suffix. Decoding it would put
			// mojibake in the brief and nothing useful in the document.
			if (slice.subarray(0, 4096).includes(0)) {
				return undefined
			}
			return slice.toString("utf8")
		} finally {
			await handle.close()
		}
	} catch {
		return undefined
	}
}

/** Walk the project and read everything in it that is text. */
export async function digestRepository(root: string, maxFiles = 4_000): Promise<RepoDigest> {
	const files: DigestFile[] = []
	const configs: RepoDigest["configs"] = []
	const byDirectory = new Map<string, DigestDirectory>()
	let totalLines = 0
	let truncated = false

	const walk = async (directory: string): Promise<void> => {
		if (truncated) {
			return
		}
		let entries
		try {
			entries = await fs.readdir(directory, { withFileTypes: true })
		} catch {
			return
		}
		entries.sort((a, b) => a.name.localeCompare(b.name))
		for (const entry of entries) {
			if (truncated) {
				return
			}
			const full = path.join(directory, entry.name)
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) {
					continue
				}
				await walk(full)
				continue
			}
			if (!entry.isFile()) {
				continue
			}
			const lower = entry.name.toLowerCase()
			if (lower.startsWith(".") && !CONFIG_NAMES.has(lower)) {
				continue
			}
			if (endsWithAny(lower, SKIP_SUFFIXES)) {
				continue
			}
			if (!endsWithAny(lower, TEXT_SUFFIXES) && !CONFIG_NAMES.has(lower)) {
				continue
			}
			if (files.length >= maxFiles) {
				truncated = true
				return
			}
			const text = await readTextFile(full)
			if (text === undefined) {
				continue
			}
			const relative = path.relative(root, full).split(path.sep).join("/")
			const suffix = path.extname(relative).toLowerCase()
			const lines = text.split("\n").length
			totalLines += lines

			const top = relative.includes("/") ? relative.split("/")[0] : "."
			const bucket = byDirectory.get(top) ?? { name: top, files: 0, lines: 0 }
			bucket.files += 1
			bucket.lines += lines
			byDirectory.set(top, bucket)

			const defines: string[] = []
			const pattern = definitionPattern(suffix)
			if (pattern) {
				// A /g regex carries its own cursor; reusing one across files
				// makes it start halfway through the next.
				const scanner = new RegExp(pattern.source, pattern.flags)
				let match: RegExpExecArray | null
				while ((match = scanner.exec(text)) !== null && defines.length < 25) {
					const name = match.slice(1).find(Boolean)
					if (name && !name.startsWith("_") && !defines.includes(name)) {
						defines.push(name)
					}
				}
			}

			files.push({ path: relative, lines, purpose: headerComment(text, suffix), defines })
			if (CONFIG_NAMES.has(path.basename(relative).toLowerCase())) {
				configs.push({
					path: relative,
					text: text.slice(0, CONFIG_MAX),
					clipped: text.length > CONFIG_MAX,
				})
			}
		}
	}

	await walk(root)
	files.sort((a, b) => b.lines - a.lines)

	return {
		name: path.basename(root) || root,
		root,
		fileCount: files.length,
		totalLines,
		truncated,
		directories: [...byDirectory.values()].sort((a, b) => b.lines - a.lines),
		files,
		configs,
	}
}

const depthHint = (digest: RepoDigest): string => {
	const components = Math.min(14, Math.max(4, digest.directories.length))
	return (
		`This project has ${digest.fileCount} files across ${digest.directories.length} top-level ` +
		`directories, so aim for at least ${components} sections and give the larger components ` +
		`several paragraphs each — a page of prose about a project this size is a summary, not ` +
		`documentation.`
	)
}

/**
 * The digest as a brief, largest files first.
 *
 * Ordered by size because that is the cheapest honest proxy for "load-bearing",
 * and the budget is spent from the top: a truncated brief should lose the
 * smallest files rather than an arbitrary tail of the alphabet.
 */
export function digestToBrief(digest: RepoDigest, budget = 90_000): string {
	const head: string[] = [
		`Write complete technical documentation for the project '${digest.name}'.`,
		"",
		"Everything below was read from the project itself — file names, sizes, the purpose each " +
			"file states, and the functions and classes it defines. Describe only what appears here. " +
			"Do not name a file, command, framework or setting that is not listed: this material is " +
			"the whole of what is known about the project, and anything added to it is a guess " +
			"presented as documentation.",
		"",
		`Scale: ${digest.fileCount} source files, ${digest.totalLines.toLocaleString("en-US")} lines` +
			(digest.truncated ? " (file limit reached — the largest files are included)" : "") +
			".",
		"",
		"TOP-LEVEL LAYOUT (directory: files, lines)",
	]
	for (const entry of digest.directories) {
		head.push(`  ${entry.name}: ${entry.files} files, ${entry.lines.toLocaleString("en-US")} lines`)
	}

	// An explicit checklist, not a target number. Given a count the writer picks
	// its own components and covers two; given the components by name it covers
	// the ones it is given.
	head.push("", "COMPONENTS — write one section for each of these, named after it")
	for (const entry of digest.directories) {
		const largest = digest.files
			.filter((file) => (entry.name === "." ? !file.path.includes("/") : file.path.startsWith(`${entry.name}/`)))
			.slice(0, 4)
			.map((file) => file.path)
		head.push(
			`  ${entry.name} — ${entry.files} files, ${entry.lines.toLocaleString("en-US")} lines` +
				(largest.length ? `; largest: ${largest.join(", ")}` : ""),
		)
	}

	head.push("", "CONFIGURATION AND DOCUMENTATION FILES, VERBATIM")
	for (const config of digest.configs) {
		head.push(
			`--- ${config.path} ---`,
			config.text.trim(),
			config.clipped ? "--- (clipped) ---" : "--- end ---",
			"",
		)
	}
	head.push("", "SOURCE FILES — path, size, stated purpose, and what it defines")

	const body = head.join("\n")
	const tail: string[] = []
	let used = body.length
	for (const [index, file] of digest.files.entries()) {
		let line = `  ${file.path} (${file.lines} lines)`
		if (file.purpose) {
			line += `\n      purpose: ${file.purpose}`
		}
		if (file.defines.length) {
			line += `\n      defines: ${file.defines.join(", ")}`
		}
		if (used + line.length > budget) {
			tail.push(`  ... ${digest.files.length - index} smaller files omitted for length`)
			break
		}
		used += line.length
		tail.push(line)
	}

	return (
		`${body}\n${tail.join("\n")}\n\n` +
		"Write it in this order: what the project is and what it is for; how the repository is laid " +
		"out; then one section per significant component — named after the directory or file it " +
		"covers, saying what it does, what it defines and how it fits the rest; then configuration; " +
		"then how the thing is run; and a conclusion last if you write one at all. " +
		`${depthHint(digest)} Use the real names throughout, and prefer a component's own stated ` +
		"purpose over a description you compose. Do not write a section about what this material " +
		"does not say."
	)
}

/**
 * The file inventory and a chart of it, as blocks the cluster typesets as given.
 *
 * A model asked to reproduce a hundred-row table spends its whole budget on it
 * and gets rows wrong. These numbers are already known here, so nothing needs
 * to retype them.
 */
export function digestToBlocks(digest: RepoDigest, maxRows = 400): SpecBlock[] {
	const top = digest.directories.filter((entry) => entry.lines > 0).slice(0, 10)
	const blocks: SpecBlock[] = [
		{ type: "pagebreak" },
		{ type: "heading", level: 1, text: "Appendix: where the code is" },
	]
	if (top.length) {
		const share = Math.round((100 * top[0].lines) / Math.max(digest.totalLines, 1))
		blocks.push({
			type: "chart",
			chart: "bar",
			// "." is what a walk calls the root; nobody reads a chart axis and
			// thinks "full stop means the top level".
			labels: top.map((entry) => (entry.name === "." ? "(root)" : entry.name)),
			values: top.map((entry) => entry.lines),
			caption: `Lines of code by top-level directory. ${top[0].name} alone holds ${share}% of the project.`,
		})
	}
	blocks.push(
		{ type: "heading", level: 1, text: "Appendix: file inventory" },
		{
			type: "paragraph",
			text:
				`Every source file found in the project, largest first: ${digest.fileCount} files ` +
				`totalling ${digest.totalLines.toLocaleString("en-US")} lines. The purpose column is ` +
				`the file's own header comment or docstring, quoted, not a summary.`,
		},
	)
	if (digest.files.length > maxRows) {
		blocks.push({
			type: "paragraph",
			text: `The ${digest.files.length - maxRows} smallest files are omitted from this table.`,
		})
	}
	blocks.push({
		type: "table",
		header: ["File", "Lines", "Purpose"],
		rows: digest.files
			.slice(0, maxRows)
			.map((file) => [file.path, String(file.lines), (file.purpose || "").slice(0, 120)]),
	})
	return blocks
}
