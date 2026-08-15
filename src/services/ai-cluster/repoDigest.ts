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
	// Conventional homes for code that came from somewhere else.
	"third_party",
	"thirdparty",
	"external",
	"submodules",
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

/**
 * What the project offers someone who wants to *use* it.
 *
 * Kept apart from the file inventory because it answers a different question.
 * The inventory says what the code is; this says what it does when you run it —
 * and without it the documents described every module of a project and never
 * said how to start it, because nothing in the material could have told the
 * writer. Mirrors usage_surface in tools/repo_digest/repo_digest.py; the
 * headings below are what the cluster keys its user-manual sections off.
 */
export type DigestUsage = {
	entryPoints: Array<{ path: string; purpose: string }>
	commands: Array<{
		path: string
		commands: Array<{ name: string; help: string }>
		flags: Array<{ name: string; help: string }>
	}>
	routes: Array<{ method: string; path: string; handler: string; file: string }>
	env: Array<{ name: string; usedIn: string[]; default: string }>
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
	/** Edges between the project's own modules, from the imports in the code. */
	imports: DigestEdge[]
	/** Entry points, commands, endpoints and settings — the manual's material. */
	usage: DigestUsage
	/** Bundled projects that were left out of all of the above. */
	vendored: string[]
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

// Names that say nothing on their own. Every project has a config and a utils,
// and a diagram whose boxes read config, config, config is a diagram of nothing.
const GENERIC_MODULES = new Set([
	"config",
	"configs",
	"settings",
	"utils",
	"util",
	"helpers",
	"common",
	"base",
	"core",
	"types",
	"constants",
	"const",
	"index",
	"main",
	"__init__",
	"mod",
	"lib",
	"shared",
	"misc",
])

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
	// Ranking purely by how connected a module is puts `config` at the top of
	// every project ever written, and the reader learns that everything reads
	// its settings — which they knew. A name that says nothing on its own is
	// ranked below one that does, so the picture is of what this project is.
	const weight = (name: string) => {
		const stem = (name.split("/").pop() || name).toLowerCase()
		return (degree.get(name) ?? 0) * (GENERIC_MODULES.has(stem) ? 0.35 : 1)
	}
	const keep = new Set(
		[...degree.keys()].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b)).slice(0, maxNodes),
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
const ENTRY_MAIN = /^if\s+__name__\s*==\s*['"]__main__['"]/m
const ARG_FLAG = /add_argument\(\s*['"](--?[\w-]+)['"]([\s\S]*?)\)/g
const ARG_HELP = /help\s*=\s*['"]([^'"]{3,160})['"]/
const ARG_SUB = /add_parser\(\s*['"]([\w:.-]+)['"]([\s\S]*?)\)/g
const CLICK = /@(?:\w+\.)?(?:command|group)\(\s*(?:['"]([\w:.-]+)['"])?/g
const ROUTE_DECORATOR = /@(\w+)\.(get|post|put|patch|delete|route|websocket)\(\s*['"]([^'"]+)['"]/g
const ROUTE_DJANGO = /(?:^|\s)(?:re_)?path\(\s*(?:r?['"])([^'"]*)['"]\s*,\s*([\w.]+)/gm
const ROUTE_EXPRESS = /\b(?:app|router)\.(get|post|put|patch|delete|use)\(\s*['"`]([^'"`]+)['"`]/g
const ENV_PY =
	/(?:os\.environ(?:\.get)?\(?\s*\[?\s*['"]([A-Z][A-Z0-9_]{2,})['"]|os\.getenv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"])/g
const ENV_JS = /process\.env(?:\.([A-Z][A-Z0-9_]{2,})|\[['"]([A-Z][A-Z0-9_]{2,})['"]\])/g
const ENV_SH = /\$\{?([A-Z][A-Z0-9_]{3,})\}?/g
// Names declared in a table rather than read one at a time. docqa maps every
// override in a dict — {"DOCQA_BACKEND": "backend", ...} — and reads them with
// os.getenv(env_name), so a pattern looking for the name inside the call found
// none of the seven and the manual listed one.
const ENV_TABLE = /['"]([A-Z][A-Z0-9_]{3,})['"]\s*:/g
const READS_ENV = /os\.environ|os\.getenv|process\.env/
// A quoted literal, a number or a boolean. An expression is not a default
// anyone can be told to type.
const ENV_DEFAULT =
	/(?:os\.environ\.get|os\.getenv)\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*,\s*(['"][^'"]{0,60}['"]|\d[\d._]*|True|False)/g
const MAKE_TARGET = /^([a-zA-Z][\w.-]*):(?!=)/gm
const COMPOSE_SERVICE = /^ {2}([a-z][\w-]*):\s*$/gm

const each = (pattern: RegExp, text: string): RegExpExecArray[] => {
	const scanner = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g")
	const out: RegExpExecArray[] = []
	let match: RegExpExecArray | null
	while ((match = scanner.exec(text)) !== null) {
		out.push(match)
		if (out.length > 400) {
			break
		}
	}
	return out
}

const ARG_REQUIRED = /required\s*=\s*True/
const ARG_TYPE = /type\s*=\s*(\w+)/
// The r/f/b prefix belongs to the string, not to the value: `default=r"C:\x"`
// was read as a default of "r" and the manual said so in three rows.
const ARG_DEFAULT = /default\s*=\s*(?:[rfbu]{1,2})?("[^"]*"|'[^']*'|[\w.+-]+)/

/**
 * What to say about an option beside its name.
 *
 * `help=` first, because that is the author's own sentence. Where there is none
 * — and in a real project most flags had none — the type and the default are
 * still worth more than the alternative, which was a manual repeating "purpose
 * not stated in the material" eleven times.
 */
const describeFlag = (tail: string): string => {
	const help = ARG_HELP.exec(tail ?? "")
	if (help) {
		return help[1].split(/\s+/).join(" ")
	}
	const parts: string[] = []
	if (ARG_REQUIRED.test(tail ?? "")) {
		parts.push("required")
	}
	const type = ARG_TYPE.exec(tail ?? "")
	if (type) {
		parts.push(type[1])
	}
	const fallback = ARG_DEFAULT.exec(tail ?? "")
	if (fallback) {
		parts.push(`default ${fallback[1].replace(/^['"]|['"]$/g, "")}`)
	}
	return parts.join(", ")
}

const firstHelp = (tail: string): string => {
	const found = ARG_HELP.exec(tail ?? "")
	return found ? found[1].split(/\s+/).join(" ") : ""
}

/** Commands and flags a Python file accepts, as a reader would type them. */
function commandsIn(text: string) {
	const commands: Array<{ name: string; help: string }> = []
	const flags: Array<{ name: string; help: string }> = []
	for (const match of each(ARG_SUB, text)) {
		commands.push({ name: match[1], help: firstHelp(match[2]) })
	}
	for (const match of each(CLICK, text)) {
		if (match[1]) {
			commands.push({ name: match[1], help: "" })
		}
	}
	const seen = new Set<string>()
	for (const match of each(ARG_FLAG, text)) {
		if (seen.has(match[1])) {
			continue
		}
		seen.add(match[1])
		flags.push({ name: match[1], help: describeFlag(match[2]) })
	}
	return { commands: commands.slice(0, 20), flags: flags.slice(0, 25) }
}

/** HTTP paths a file serves. A URL has to look like one: `@mock.patch("requests.get")` is not a PATCH endpoint. */
function routesIn(text: string, file: string): DigestUsage["routes"] {
	const out: DigestUsage["routes"] = []
	const seen = new Set<string>()
	const keep = (method: string, raw: string, handler: string, urlByDefinition = false) => {
		if (!urlByDefinition && !raw.startsWith("/")) {
			return
		}
		// A Django re_path is a regex, and printing it raw tells a reader nothing.
		const cleaned =
			"/" +
			raw
				.replace(/\(\?P<(\w+)>[^)]*\)/g, "<$1>")
				.trim()
				.replace(/^[/^]+/, "")
				.replace(/\$$/, "")
				.replace(/\\/g, "")
		if (cleaned.startsWith("//") || cleaned.includes(" ")) {
			return
		}
		const key = `${method} ${cleaned}`
		if (seen.has(key)) {
			return
		}
		seen.add(key)
		out.push({ method, path: cleaned, handler, file })
	}
	for (const match of each(ROUTE_DECORATOR, text)) {
		const method = match[2].toUpperCase()
		keep(method === "ROUTE" ? "ANY" : method, match[3], "")
	}
	for (const match of each(ROUTE_DJANGO, text)) {
		keep("ANY", match[1] || "/", match[2], true)
	}
	for (const match of each(ROUTE_EXPRESS, text)) {
		keep(match[1].toUpperCase(), match[2], "")
	}
	return out.slice(0, 60)
}

function envIn(text: string, suffix: string, base: string): Set<string> {
	const names = new Set<string>()
	if (suffix === ".py" || suffix === ".pyi") {
		for (const match of each(ENV_PY, text)) {
			names.add(match[1] ?? match[2])
		}
		if (READS_ENV.test(text)) {
			for (const match of each(ENV_TABLE, text)) {
				names.add(match[1])
			}
		}
	} else if (JS_SUFFIXES.includes(suffix)) {
		for (const match of each(ENV_JS, text)) {
			names.add(match[1] ?? match[2])
		}
	} else if (
		suffix === ".sh" ||
		suffix === ".bash" ||
		base === ".env" ||
		base === ".env.example" ||
		base === "dockerfile"
	) {
		for (const match of each(ENV_SH, text)) {
			names.add(match[1])
		}
	}
	return names
}

/** Commands the packaging files promise: scripts, entry points, targets. */
function declaredCommands(relative: string, text: string): Array<{ name: string; help: string }> {
	const base = path.basename(relative).toLowerCase()
	const out: Array<{ name: string; help: string }> = []
	if (base === "package.json") {
		try {
			const data = JSON.parse(text) as {
				scripts?: Record<string, string>
				bin?: string | Record<string, string>
				name?: string
			}
			for (const [name, body] of Object.entries(data.scripts ?? {})) {
				out.push({ name: `npm run ${name}`, help: String(body).slice(0, 120) })
			}
			if (typeof data.bin === "string") {
				out.push({ name: String(data.name ?? relative), help: data.bin })
			} else if (data.bin) {
				out.push(...Object.entries(data.bin).map(([k, v]) => ({ name: k, help: String(v).slice(0, 120) })))
			}
		} catch {
			// A package.json that does not parse is not a command list.
		}
	} else if (base === "makefile") {
		for (const match of each(MAKE_TARGET, text)) {
			if (match[1] !== "PHONY" && match[1] !== ".PHONY") {
				out.push({ name: `make ${match[1]}`, help: "" })
			}
		}
	} else if (base === "pyproject.toml" || base === "setup.py" || base === "setup.cfg") {
		for (const match of each(/^\s*['"]?([\w.-]+)['"]?\s*=\s*['"]([\w.]+:[\w.]+)['"]/gm, text)) {
			out.push({ name: match[1], help: `runs ${match[2]}` })
		}
	} else if (base.startsWith("docker-compose") || base === "compose.yaml") {
		for (const match of each(COMPOSE_SERVICE, text)) {
			out.push({ name: `docker compose up ${match[1]}`, help: "" })
		}
	}
	return out.slice(0, 40)
}

/**
 * Directories holding somebody else's project, by their own licence.
 *
 * A real workspace had a llama.cpp checkout copied in under train/gguf: 137 of
 * its 217 files, and the manual's command table filled up with gguf-py's flags
 * rather than the project's own eight subcommands. A directory below the root
 * that ships its own LICENSE is a bundled project, and its command line is not
 * this project's command line. The files stay in the inventory — they really
 * are in the repository — but they are not what a user manual is about.
 */
const LICENCE_NAMES = new Set(["license", "license.md", "license.txt", "licence", "licence.md", "copying"])

function vendoredRoots(files: DigestFile[], marked: Iterable<string> = []): string[] {
	const roots = new Set<string>(marked)
	for (const file of files) {
		const parts = file.path.split("/")
		if (parts.length < 2) {
			continue // the root's own licence says nothing about a subtree
		}
		if (LICENCE_NAMES.has(parts[parts.length - 1].toLowerCase())) {
			roots.add(parts.slice(0, -1).join("/") + "/")
		}
	}

	// A licence inside a subtree condemns the subtree, not just the directory
	// holding it. It sat at train/gguf/llamacpp/gguf-py/LICENSE, while the tree
	// above it — llama.cpp's converters, their requirements, 137 files in all —
	// carried none, and the document gave its largest section to "Component:
	// train, 139 files, 99,872 lines" of somebody else's code.
	//
	// Two weaker signals were tried first and both let it through: a directory
	// that *only* wraps bundled projects (this one also holds converters of its
	// own), and one nothing imports (the project's scripts do call those
	// converters). What is left is depth: the mark climbs to the second level,
	// so `train/gguf/` goes and `train/`, which holds the project's own training
	// scripts, stays.
	for (const root of [...roots]) {
		const parts = root.split("/").filter(Boolean)
		if (parts.length > 2) {
			roots.add(parts.slice(0, 2).join("/") + "/")
		}
	}
	for (const root of [...roots]) {
		// Keep the list to the outermost directory of each bundled tree; the
		// ones below it are the same thing said again.
		if ([...roots].some((other) => other !== root && root.startsWith(other))) {
			roots.delete(root)
		}
	}
	return [...roots]
}

export function usageSurface(
	files: DigestFile[],
	texts: Map<string, string>,
	marked: Iterable<string> = [],
): DigestUsage {
	const entryPoints: DigestUsage["entryPoints"] = []
	const commands: DigestUsage["commands"] = []
	const routes: DigestUsage["routes"] = []
	const env = new Map<string, string[]>()
	const defaults = new Map<string, string>()

	const vendored = vendoredRoots(files, marked)
	for (const file of files) {
		if (vendored.some((root) => file.path.startsWith(root))) {
			continue
		}
		const text = texts.get(file.path) ?? ""
		const suffix = path.extname(file.path).toLowerCase()
		const base = path.basename(file.path).toLowerCase()

		if (ENTRY_MAIN.test(text) || file.path.includes("/management/commands/")) {
			entryPoints.push({ path: file.path, purpose: file.purpose })
		}
		if (suffix === ".py" || suffix === ".pyi") {
			const found = commandsIn(text)
			if (found.commands.length || found.flags.length) {
				commands.push({ path: file.path, ...found })
			}
			for (const match of each(ENV_DEFAULT, text)) {
				const value = match[2].replace(/^['"]|['"]$/g, "")
				if (value && value !== "None" && !defaults.has(match[1])) {
					defaults.set(match[1], value.slice(0, 60))
				}
			}
		}
		routes.push(...routesIn(text, file.path))
		for (const name of envIn(text, suffix, base)) {
			env.set(name, [...(env.get(name) ?? []), file.path])
		}
		const declared = declaredCommands(file.path, text)
		if (declared.length) {
			commands.push({ path: file.path, commands: declared, flags: [] })
		}
	}

	return {
		entryPoints: entryPoints.slice(0, 30),
		commands: commands.slice(0, 40),
		routes: routes.slice(0, 120),
		env: [...env.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.slice(0, 60)
			.map(([name, usedIn]) => ({ name, usedIn: usedIn.slice(0, 4), default: defaults.get(name) ?? "" })),
	}
}

export async function digestRepository(root: string, maxFiles = 4_000): Promise<RepoDigest> {
	const files: DigestFile[] = []
	const texts = new Map<string, string>()
	const configs: RepoDigest["configs"] = []
	const byDirectory = new Map<string, DigestDirectory>()
	let totalLines = 0
	let truncated = false
	// A licence file has no extension and is not quotable configuration, so the
	// walk never keeps one — and the rule that spots a bundled project by its
	// licence had nothing to look at. Noted here, while the directory is open.
	const vendoredDirs = new Set<string>()

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
		const here = path.relative(root, directory).split(path.sep).join("/")
		if (here && entries.some((entry) => entry.isFile() && LICENCE_NAMES.has(entry.name.toLowerCase()))) {
			vendoredDirs.add(here + "/")
		}
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

	// Bundled projects leave the digest here, not just the user manual. Left in,
	// llama.cpp's tooling was 137 of one workspace's 217 files and the document
	// gave its largest section to it — "Component: train, 139 files, 99,872
	// lines" — describing somebody else's conversion scripts as the project's
	// own. The counts, the components and the inventory now all mean the same
	// thing: this project.
	const vendored = vendoredRoots(files, vendoredDirs)
	const own = vendored.length
		? files.filter((file) => !vendored.some((prefix) => file.path.startsWith(prefix)))
		: files
	const excluded = files.length - own.length
	const ownTotalLines = excluded ? own.reduce((sum, file) => sum + file.lines, 0) : totalLines
	const ownDirectories = excluded ? countDirectories(own) : [...byDirectory.values()]

	const imports = importEdges(own, texts)
	const usage = usageSurface(own, texts, vendored)
	own.sort((a, b) => b.lines - a.lines)

	return {
		name: path.basename(root) || root,
		root,
		fileCount: own.length,
		totalLines: ownTotalLines,
		truncated,
		directories: ownDirectories.sort((a, b) => b.lines - a.lines),
		files: own,
		configs: configs.filter((config) => !vendored.some((prefix) => config.path.startsWith(prefix))),
		imports,
		usage,
		vendored,
	}
}

function countDirectories(files: DigestFile[]): DigestDirectory[] {
	const byDirectory = new Map<string, DigestDirectory>()
	for (const file of files) {
		const top = file.path.includes("/") ? file.path.split("/")[0] : "."
		const bucket = byDirectory.get(top) ?? { name: top, files: 0, lines: 0 }
		bucket.files += 1
		bucket.lines += file.lines
		byDirectory.set(top, bucket)
	}
	return [...byDirectory.values()]
}

/**
 * The usage surface, written out for the sections that become the manual.
 *
 * The wording and the headings match tools/repo_digest/repo_digest.py exactly:
 * the cluster looks for "HOW THE PROJECT IS RUN AND WHAT IT ACCEPTS" to decide
 * that a document needs a user manual, and for the four sub-headings to decide
 * which parts of one. A brief without them gets a document that describes the
 * code and never says how to run it — which is what the extension was sending.
 */
function usageLines(usage: DigestUsage | undefined): string[] {
	if (!usage) {
		return []
	}
	const out = [
		"",
		"HOW THE PROJECT IS RUN AND WHAT IT ACCEPTS",
		"  (read out of the source; write the user-manual sections from this and invent nothing to fill a gap)",
	]
	if (usage.entryPoints.length) {
		out.push("  RUNNABLE FILES — each of these is started directly")
		for (const entry of usage.entryPoints.slice(0, 20)) {
			out.push(`    ${entry.path}${entry.purpose ? ` — ${entry.purpose.slice(0, 120)}` : ""}`)
		}
	}
	if (usage.commands.length) {
		out.push("  COMMANDS AND OPTIONS")
		for (const file of usage.commands.slice(0, 25)) {
			out.push(`    in ${file.path}:`)
			for (const command of file.commands.slice(0, 12)) {
				out.push(`      command ${command.name}${command.help ? ` — ${command.help}` : ""}`)
			}
			for (const flag of file.flags.slice(0, 14)) {
				out.push(`      option ${flag.name}${flag.help ? ` — ${flag.help}` : ""}`)
			}
		}
	}
	if (usage.routes.length) {
		out.push("  HTTP ENDPOINTS SERVED")
		for (const route of usage.routes.slice(0, 90)) {
			out.push(
				`    ${route.method.padEnd(6)} ${route.path}` +
					(route.handler ? `  (${route.handler})` : "") +
					`  [${route.file}]`,
			)
		}
	}
	if (usage.env.length) {
		out.push("  ENVIRONMENT VARIABLES READ")
		for (const variable of usage.env.slice(0, 50)) {
			out.push(
				`    ${variable.name} — read in ${variable.usedIn.join(", ")}` +
					(variable.default ? `; default ${variable.default}` : ""),
			)
		}
	}
	return out.length === 3 ? [] : out
}

/** Which parts of a manual this material can support, named for the writer. */
function manualHint(usage: DigestUsage | undefined): string {
	const parts: string[] = []
	if (usage?.entryPoints.length) {
		parts.push(`${usage.entryPoints.length} runnable files`)
	}
	const options = (usage?.commands ?? []).reduce((total, file) => total + file.commands.length + file.flags.length, 0)
	if (options) {
		parts.push(`${options} commands and options`)
	}
	if (usage?.routes.length) {
		parts.push(`${usage.routes.length} endpoints`)
	}
	if (usage?.env.length) {
		parts.push(`${usage.env.length} environment variables`)
	}
	if (!parts.length) {
		return "The material lists no commands or endpoints, so say in the running section how the code is entered and leave it there."
	}
	return (
		`The usage material above lists ${parts.join(", ")}; the user-manual sections have to account ` +
		"for all of them, in tables where there is more than a handful, with the name exactly as a " +
		"user would type it and what it does beside it."
	)
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

	head.push(...usageLines(digest.usage))

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
		"covers, saying what it does, what it defines and how it fits the rest; then the user " +
		"manual — a section for getting it running, a section listing every command and option with " +
		"what each one does, a section for the HTTP endpoints if there are any, and a section for " +
		"configuration and environment variables; and a conclusion last if you write one at all. " +
		`${manualHint(digest.usage)} ` +
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
