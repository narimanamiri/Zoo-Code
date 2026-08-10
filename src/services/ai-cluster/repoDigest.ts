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

export type DigestEdge = { from: string; to: string }

export type RepoDigest = {
	name: string
	root: string
	fileCount: number
	totalLines: number
	truncated: boolean
	directories: DigestDirectory[]
	files: DigestFile[]
	configs: Array<{ path: string; text: string; clipped: boolean }>
	/** Edges between the project's own modules, from the imports in the code. */
	imports: DigestEdge[]
}

/** Blocks the caller already holds as fact, typeset verbatim by the cluster. */
export type SpecBlock = Record<string, unknown>

/**
 * Every module path a file names, before any of them are resolved.
 *
 * Python needs more than one pattern: `from . import build, charts` names its
 * siblings in the import list rather than in the module path, which is how most
 * packages import themselves — a single regex for `from X import Y` finds "."
 * and nothing useful. Mirrors _raw_imports in tools/repo_digest/repo_digest.py.
 */
const PY_FROM = /^[ \t]*from[ \t]+([.\w]+)[ \t]+import[ \t]+(.+)$/gm
const PY_IMPORT = /^[ \t]*import[ \t]+([.\w][.\w, \t]*)$/gm
const JS_IMPORT = /(?:from[ \t]+|require\([ \t]*|import[ \t]+)['"]([^'"]+)['"]/g
const GO_IMPORT = /"([\w./-]+)"/g
const RS_IMPORT = /^[ \t]*use[ \t]+(?:crate::)?([\w:]+)/gm

const JS_SUFFIXES = [".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte", ".mjs", ".cjs"]

function rawImports(text: string, suffix: string): string[] {
	const out: string[] = []
	const scan = (pattern: RegExp, take: (m: RegExpExecArray) => void) => {
		const scanner = new RegExp(pattern.source, pattern.flags)
		let match: RegExpExecArray | null
		while ((match = scanner.exec(text)) !== null) {
			take(match)
		}
	}
	if (suffix === ".py" || suffix === ".pyi") {
		scan(PY_FROM, (m) => {
			const [, pkg, names] = m
			const parts = names
				.split(",")
				.map((n) => n.trim().split(" as ")[0])
				.filter(Boolean)
			if (pkg.replace(/\./g, "") === "") {
				out.push(...parts)
			} else {
				out.push(pkg, ...parts.map((n) => `${pkg}/${n}`))
			}
		})
		scan(PY_IMPORT, (m) => out.push(...m[1].split(",").map((n) => n.trim().split(" as ")[0])))
	} else if (JS_SUFFIXES.includes(suffix)) {
		scan(JS_IMPORT, (m) => out.push(m[1]))
	} else if (suffix === ".go") {
		scan(GO_IMPORT, (m) => out.push(m[1]))
	} else if (suffix === ".rs") {
		scan(RS_IMPORT, (m) => out.push(m[1]))
	}
	return out.filter((entry) => entry && entry !== "*")
}

/** The name a file is known by inside its own project. */
export function moduleName(relative: string): string {
	return relative.replace(/\.[^.]+$/, "").replace(/\/(index|__init__|mod)$/, "") || relative
}

/**
 * Edges between the project's own modules, from what each file imports.
 *
 * Resolved by matching the tail of an import against the modules that exist.
 * Anything that resolves to nothing was a third-party package, and a diagram of
 * everything that imports the standard library is not a diagram of anything.
 */
export function importEdges(files: DigestFile[], texts: Map<string, string>): DigestEdge[] {
	const modules = files.map((file) => moduleName(file.path))
	const byTail = new Map<string, Set<string>>()
	for (const name of modules) {
		const parts = name.split("/")
		for (let depth = 1; depth <= 3; depth++) {
			const tail = parts.slice(-depth).join("/")
			if (!byTail.has(tail)) {
				byTail.set(tail, new Set())
			}
			byTail.get(tail)!.add(name)
		}
	}

	const edges: DigestEdge[] = []
	const seen = new Set<string>()
	for (const file of files) {
		const text = texts.get(file.path)
		if (!text) {
			continue
		}
		const source = moduleName(file.path)
		for (const raw of rawImports(text, path.extname(file.path).toLowerCase())) {
			const candidate = raw
				.replace(/::/g, "/")
				.replace(/\./g, "/")
				.replace(/^(?:\.\.\/|\.\/)+/, "")
			const parts = candidate.split("/").filter(Boolean)
			const names = new Set<string>()
			for (let depth = 1; depth <= 3; depth++) {
				for (const name of byTail.get(parts.slice(-depth).join("/")) ?? []) {
					names.add(name)
				}
			}
			for (const target of names) {
				const key = `${source} -> ${target}`
				if (target !== source && !seen.has(key)) {
					seen.add(key)
					edges.push({ from: source, to: target })
				}
			}
		}
	}
	return edges
}

/**
 * The project's own modules and the imports between them, as a diagram.
 *
 * Trimmed to the most connected modules: a graph of two hundred files is a
 * picture of a hairball. Null when there are no internal imports to draw, which
 * is the honest answer for a pile of scripts.
 */
export function dependencyDiagram(digest: RepoDigest, maxNodes = 12): SpecBlock | null {
	const edges = digest.imports ?? []
	if (edges.length < 2) {
		return null
	}
	const degree = new Map<string, number>()
	for (const edge of edges) {
		degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1)
		degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1)
	}
	const keep = new Set(
		[...degree.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, maxNodes)
			.map(([name]) => name),
	)
	const kept = edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to))
	if (kept.length < 2) {
		return null
	}
	// Four boxes all labelled "config" is not a diagram of anything. A file's
	// own name is the label until two of them collide, and then each keeps
	// enough of its path to tell them apart.
	const byShort = new Map<string, string[]>()
	for (const name of keep) {
		const short = name.split("/").pop() || name
		byShort.set(short, [...(byShort.get(short) ?? []), name])
	}
	const labels = new Map<string, string>()
	for (const [short, names] of byShort) {
		for (const name of names) {
			const parts = name.split("/")
			labels.set(name, names.length === 1 ? short : parts.slice(-2).join("/"))
		}
	}

	return {
		type: "diagram",
		diagram: "graph",
		direction: "right",
		nodes: [...keep].sort().map((name) => ({ id: name, label: labels.get(name) ?? name })),
		edges: kept,
		caption:
			`Imports between the ${keep.size} most connected modules of ${digest.name}, taken from ` +
			`the source. An arrow points at what a module depends on.`,
	}
}

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
	const texts = new Map<string, string>()
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
			texts.set(relative, text)
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
	const imports = importEdges(files, texts)
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
		imports,
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
	const graph = dependencyDiagram(digest)
	const blocks: SpecBlock[] = [
		{ type: "pagebreak" },
		{ type: "heading", level: 1, text: "Appendix: how the modules fit together" },
		{
			type: "paragraph",
			text:
				"Drawn from the imports in the code itself: an arrow runs from a module to the " +
				"module it imports. Only the project's own modules appear — third-party packages " +
				"are left out, because a diagram of everything that imports the standard library " +
				"is not a diagram of anything.",
		},
	]
	if (graph) {
		blocks.push(graph)
	} else {
		blocks.push({
			type: "paragraph",
			text: "This project's files do not import one another, so there is no dependency graph to draw.",
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
