/**
 * Just enough `vscode` for a tool to be bundled and run outside the editor.
 *
 * The document tool touches none of this itself, but the modules it imports for
 * paths and responses pull the API in at load time. Anything genuinely needed
 * would throw here rather than quietly doing nothing.
 */
const nothing = () => undefined
const proxy = new Proxy(
	{},
	{
		get: (_target, key) => {
			if (key === "then") {
				return undefined // so it is not mistaken for a promise
			}
			return proxy
		},
		apply: () => proxy,
	},
)

module.exports = {
	workspace: {
		workspaceFolders: undefined,
		getConfiguration: () => ({ get: nothing, update: nothing }),
		onDidChangeConfiguration: () => ({ dispose: nothing }),
		fs: proxy,
	},
	window: {
		showInformationMessage: nothing,
		showWarningMessage: nothing,
		showErrorMessage: nothing,
		createOutputChannel: () => ({ appendLine: nothing, show: nothing, dispose: nothing }),
		activeTextEditor: undefined,
		tabGroups: { all: [], onDidChangeTabs: () => ({ dispose: nothing }) },
	},
	commands: { executeCommand: nothing, registerCommand: () => ({ dispose: nothing }) },
	env: { language: "en", appName: "node", machineId: "probe" },
	Uri: {
		file: (value) => ({ fsPath: value, path: value, scheme: "file", toString: () => value }),
		parse: (value) => ({ fsPath: value, path: value, scheme: "file", toString: () => value }),
		joinPath: (base, ...parts) => ({ fsPath: [base?.fsPath, ...parts].join("/") }),
	},
	EventEmitter: class {
		constructor() {
			this.event = () => ({ dispose: nothing })
		}
		fire() {}
		dispose() {}
	},
	Disposable: { from: () => ({ dispose: nothing }) },
	RelativePattern: class {},
	FileType: { File: 1, Directory: 2 },
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
	ExtensionMode: { Production: 1, Development: 2, Test: 3 },
	ProgressLocation: { Notification: 15, Window: 10 },
	ThemeIcon: class {},
	TabInputText: class {},
	version: "0.0.0-probe",
}
