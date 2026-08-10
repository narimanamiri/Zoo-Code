import type OpenAI from "openai"

const DOCUMENT_PROJECT_DESCRIPTION = `Read an entire codebase and write real documentation for it as a .docx, .pdf or .pptx file, saved into the workspace.

USE THIS — do not do it by hand — whenever the user asks for documentation of a project, a repository, a codebase, or "all the code": for example "read this project and document everything", "write full documentation for this repo", "make a Word document describing this codebase".

Do NOT read the files yourself first and do NOT write the document yourself. This tool walks the whole project, extracts every file's own header comment and definitions, and sends that to the cluster to be typeset. Writing it from what you have read produces a few paragraphs about the two or three files that fit in context, which is the failure this tool exists to prevent.

The file is written directly into the workspace. There is no link to follow and nothing to download.

Parameters:
- path: (required) where to save the document, relative to the workspace. The extension chooses the format from the extension: .docx, .pdf or .pptx.
- source: (optional) the directory to read, relative to the workspace. Defaults to the whole workspace. Point it at a subdirectory to document one part of a project.
- title: (optional) title for the document. Defaults to the project's own name.
- author: (optional) author for the cover page.

Example: documenting the whole project
{ "path": "docs/project-documentation.docx", "source": null, "title": null, "author": null }

Example: documenting one component as a PDF
{ "path": "docs/api-server.pdf", "source": "services/api", "title": "API server", "author": null }`

const PATH_PARAMETER_DESCRIPTION = `Where to save the document, relative to the workspace. Must end in .docx, .pdf or .pptx`

const SOURCE_PARAMETER_DESCRIPTION = `Directory to read, relative to the workspace. Null or omitted reads the whole workspace`

const TITLE_PARAMETER_DESCRIPTION = `Title for the document. Null uses the project's directory name`

const AUTHOR_PARAMETER_DESCRIPTION = `Author for the cover page. Null leaves it off rather than inventing one`

export default {
	type: "function",
	function: {
		name: "document_project",
		description: DOCUMENT_PROJECT_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: PATH_PARAMETER_DESCRIPTION,
				},
				source: {
					type: ["string", "null"],
					description: SOURCE_PARAMETER_DESCRIPTION,
				},
				title: {
					type: ["string", "null"],
					description: TITLE_PARAMETER_DESCRIPTION,
				},
				author: {
					type: ["string", "null"],
					description: AUTHOR_PARAMETER_DESCRIPTION,
				},
			},
			required: ["path", "source", "title", "author"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
