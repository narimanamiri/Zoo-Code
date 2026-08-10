// npx vitest run src/services/ai-cluster/__tests__/mcpRegistration.spec.ts

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

vitest.mock("vscode", () => ({ workspace: { getConfiguration: () => ({ get: (_k: string, d?: unknown) => d }) } }))

import { AI_CLUSTER_MCP_SERVER_NAME, registerClusterMcpServer, unregisterClusterMcpServer } from "../mcpRegistration"

let settingsPath: string

const read = async () => JSON.parse(await fs.readFile(settingsPath, "utf-8"))

describe("cluster MCP registration", () => {
	beforeEach(async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cluster-mcp-"))
		settingsPath = path.join(dir, "mcp_settings.json")
	})

	afterEach(async () => {
		await fs.rm(path.dirname(settingsPath), { recursive: true, force: true })
	})

	it("adds a streamable-http entry pointing at /mcp on the cluster's origin", async () => {
		await fs.writeFile(settingsPath, JSON.stringify({ mcpServers: {} }))

		expect(await registerClusterMcpServer(settingsPath, "http://10.0.0.5:18080/v1")).toBe(true)
		expect((await read()).mcpServers[AI_CLUSTER_MCP_SERVER_NAME]).toEqual({
			type: "streamable-http",
			url: "http://10.0.0.5:18080/mcp",
		})
	})

	it("keeps other servers untouched", async () => {
		await fs.writeFile(settingsPath, JSON.stringify({ mcpServers: { other: { command: "node", args: ["x"] } } }))

		await registerClusterMcpServer(settingsPath, "http://10.0.0.5:18080/v1")

		expect((await read()).mcpServers.other).toEqual({ command: "node", args: ["x"] })
	})

	it("preserves fields the user set by hand", async () => {
		await fs.writeFile(
			settingsPath,
			JSON.stringify({
				mcpServers: {
					[AI_CLUSTER_MCP_SERVER_NAME]: {
						type: "streamable-http",
						url: "http://old:18080/mcp",
						disabled: true,
						alwaysAllow: ["list_skills"],
					},
				},
			}),
		)

		await registerClusterMcpServer(settingsPath, "http://10.0.0.5:18080/v1")

		expect((await read()).mcpServers[AI_CLUSTER_MCP_SERVER_NAME]).toEqual({
			type: "streamable-http",
			url: "http://10.0.0.5:18080/mcp",
			disabled: true,
			alwaysAllow: ["list_skills"],
		})
	})

	it("does not rewrite an identical entry", async () => {
		// The hub watches this file: an identical write reconnects every server.
		await fs.writeFile(settingsPath, JSON.stringify({ mcpServers: {} }))
		await registerClusterMcpServer(settingsPath, "http://10.0.0.5:18080/v1")

		expect(await registerClusterMcpServer(settingsPath, "http://10.0.0.5:18080/v1")).toBe(false)
	})

	it("registers into a settings file that does not exist yet", async () => {
		expect(await registerClusterMcpServer(settingsPath, "http://10.0.0.5:18080")).toBe(true)
		expect((await read()).mcpServers[AI_CLUSTER_MCP_SERVER_NAME].url).toBe("http://10.0.0.5:18080/mcp")
	})

	it("recovers from an unparsable settings file", async () => {
		await fs.writeFile(settingsPath, "{ not json")
		expect(await registerClusterMcpServer(settingsPath, "http://10.0.0.5:18080/v1")).toBe(true)
	})

	it("removes the entry and reports whether there was one", async () => {
		await registerClusterMcpServer(settingsPath, "http://10.0.0.5:18080/v1")

		expect(await unregisterClusterMcpServer(settingsPath)).toBe(true)
		expect((await read()).mcpServers).toEqual({})
		expect(await unregisterClusterMcpServer(settingsPath)).toBe(false)
	})
})
