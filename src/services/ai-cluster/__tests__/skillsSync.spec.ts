// npx vitest run src/services/ai-cluster/__tests__/skillsSync.spec.ts

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

vitest.mock("vscode", () => ({ workspace: { getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }) } }))

let skillsRoot: string

vitest.mock("../../roo-config", () => ({
	getGlobalRooDirectory: () => skillsRoot,
}))

const fetchClusterSkills = vitest.fn()
const fetchClusterSkill = vitest.fn()
const fetchClusterSkillFile = vitest.fn()

vitest.mock("../client", () => ({
	fetchClusterSkills: (...args: unknown[]) => fetchClusterSkills(...args),
	fetchClusterSkill: (...args: unknown[]) => fetchClusterSkill(...args),
	fetchClusterSkillFile: (...args: unknown[]) => fetchClusterSkillFile(...args),
}))

import { syncClusterSkills, clearClusterSkills, getClusterSkillsDirectory } from "../skillsSync"

const credentials = { baseUrl: "http://10.0.0.5:18080/v1" }

const summary = (name: string, digest: string, files: { path: string; bytes?: number; text?: string }[] = []) => ({
	name,
	description: `what ${name} is for`,
	digest,
	files,
})

const detail = (name: string, body: string, files: { path: string; bytes?: number; text?: string }[] = []) => ({
	...summary(name, "ignored", files),
	content: `---\nname: ${name}\ndescription: d\n---\n${body}`,
})

const exists = (target: string) =>
	fs
		.stat(target)
		.then(() => true)
		.catch(() => false)

describe("syncClusterSkills", () => {
	beforeEach(async () => {
		skillsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cluster-skills-"))
		vitest.clearAllMocks()
	})

	afterEach(async () => {
		await fs.rm(skillsRoot, { recursive: true, force: true })
	})

	it("writes each skill and its inlined files", async () => {
		fetchClusterSkills.mockResolvedValue([summary("docforge", "aaa", [{ path: "api.md", text: "# api" }])])
		fetchClusterSkill.mockResolvedValue(detail("docforge", "body", [{ path: "api.md", text: "# api" }]))

		const result = await syncClusterSkills(credentials)

		expect(result.added).toEqual(["docforge"])
		const dir = path.join(getClusterSkillsDirectory(), "docforge")
		expect(await fs.readFile(path.join(dir, "SKILL.md"), "utf-8")).toContain("name: docforge")
		expect(await fs.readFile(path.join(dir, "api.md"), "utf-8")).toBe("# api")
	})

	it("downloads files the list did not inline", async () => {
		fetchClusterSkills.mockResolvedValue([summary("docforge", "aaa", [{ path: "logo.png", bytes: 4096 }])])
		fetchClusterSkill.mockResolvedValue(detail("docforge", "body", [{ path: "logo.png", bytes: 4096 }]))
		fetchClusterSkillFile.mockResolvedValue(Buffer.from([1, 2, 3]))

		await syncClusterSkills(credentials)

		expect(fetchClusterSkillFile).toHaveBeenCalledWith(credentials, "docforge", "logo.png")
		const written = await fs.readFile(path.join(getClusterSkillsDirectory(), "docforge", "logo.png"))
		expect(Array.from(written)).toEqual([1, 2, 3])
	})

	it("skips a skill whose digest has not changed", async () => {
		fetchClusterSkills.mockResolvedValue([summary("docforge", "aaa")])
		fetchClusterSkill.mockResolvedValue(detail("docforge", "body"))

		await syncClusterSkills(credentials)
		fetchClusterSkill.mockClear()

		const second = await syncClusterSkills(credentials)

		expect(second.unchanged).toEqual(["docforge"])
		expect(fetchClusterSkill).not.toHaveBeenCalled()
	})

	it("re-downloads when the digest moves", async () => {
		fetchClusterSkills.mockResolvedValue([summary("docforge", "aaa")])
		fetchClusterSkill.mockResolvedValue(detail("docforge", "first"))
		await syncClusterSkills(credentials)

		fetchClusterSkills.mockResolvedValue([summary("docforge", "bbb")])
		fetchClusterSkill.mockResolvedValue(detail("docforge", "second"))
		const second = await syncClusterSkills(credentials)

		expect(second.updated).toEqual(["docforge"])
		expect(await fs.readFile(path.join(getClusterSkillsDirectory(), "docforge", "SKILL.md"), "utf-8")).toContain(
			"second",
		)
	})

	it("removes a skill that is gone from the cluster", async () => {
		fetchClusterSkills.mockResolvedValue([summary("docforge", "aaa"), summary("ppt-generate", "bbb")])
		fetchClusterSkill.mockImplementation(async (_c: unknown, name: string) => detail(name, "body"))
		await syncClusterSkills(credentials)

		fetchClusterSkills.mockResolvedValue([summary("docforge", "aaa")])
		const second = await syncClusterSkills(credentials)

		expect(second.removed).toEqual(["ppt-generate"])
		expect(await exists(path.join(getClusterSkillsDirectory(), "ppt-generate"))).toBe(false)
	})

	it("leaves files it did not write alone", async () => {
		// The directory is ours, but anything not in the manifest was put there by
		// someone else and deleting it would be a surprise.
		fetchClusterSkills.mockResolvedValue([summary("docforge", "aaa")])
		fetchClusterSkill.mockResolvedValue(detail("docforge", "body"))
		await fs.mkdir(path.join(getClusterSkillsDirectory(), "hand-written"), { recursive: true })
		await fs.writeFile(path.join(getClusterSkillsDirectory(), "hand-written", "SKILL.md"), "mine")

		await syncClusterSkills(credentials)

		expect(await exists(path.join(getClusterSkillsDirectory(), "hand-written", "SKILL.md"))).toBe(true)
	})

	it("resyncs from scratch when the cluster address changes", async () => {
		fetchClusterSkills.mockResolvedValue([summary("docforge", "aaa")])
		fetchClusterSkill.mockResolvedValue(detail("docforge", "body"))
		await syncClusterSkills(credentials)
		fetchClusterSkill.mockClear()

		const second = await syncClusterSkills({ baseUrl: "http://other:18080/v1" })

		expect(second.updated).toEqual(["docforge"])
		expect(fetchClusterSkill).toHaveBeenCalled()
	})

	it("refuses a skill name that is not a plain skill name", async () => {
		fetchClusterSkills.mockResolvedValue([summary("../../evil", "aaa"), summary("Docforge", "bbb")])

		const result = await syncClusterSkills(credentials)

		expect(result.failed.map((f) => f.name).sort()).toEqual(["../../evil", "Docforge"])
		expect(fetchClusterSkill).not.toHaveBeenCalled()
	})

	it("drops a bundled path that tries to climb out of the skill", async () => {
		const escaping = [
			{ path: "../../escaped.md", text: "nope" },
			{ path: "ok.md", text: "yes" },
		]
		fetchClusterSkills.mockResolvedValue([summary("docforge", "aaa", escaping)])
		fetchClusterSkill.mockResolvedValue(detail("docforge", "body", escaping))

		await syncClusterSkills(credentials)

		expect(await exists(path.join(skillsRoot, "escaped.md"))).toBe(false)
		expect(await exists(path.join(getClusterSkillsDirectory(), "docforge", "ok.md"))).toBe(true)
	})

	it("keeps the other skills when one fails", async () => {
		fetchClusterSkills.mockResolvedValue([summary("docforge", "aaa"), summary("ppt-generate", "bbb")])
		fetchClusterSkill.mockImplementation(async (_c: unknown, name: string) => {
			if (name === "docforge") {
				throw new Error("boom")
			}
			return detail(name, "body")
		})

		const result = await syncClusterSkills(credentials)

		expect(result.failed).toEqual([{ name: "docforge", error: "boom" }])
		expect(result.added).toEqual(["ppt-generate"])
	})

	it("retries a failed skill on the next run", async () => {
		fetchClusterSkills.mockResolvedValue([summary("docforge", "aaa")])
		fetchClusterSkill.mockRejectedValueOnce(new Error("boom"))
		await syncClusterSkills(credentials)

		fetchClusterSkill.mockResolvedValue(detail("docforge", "body"))
		const second = await syncClusterSkills(credentials)

		expect(second.added).toEqual(["docforge"])
	})
})

describe("clearClusterSkills", () => {
	it("removes the whole mirror", async () => {
		skillsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cluster-skills-"))
		await fs.mkdir(getClusterSkillsDirectory(), { recursive: true })

		await clearClusterSkills()

		expect(await exists(getClusterSkillsDirectory())).toBe(false)
	})
})
