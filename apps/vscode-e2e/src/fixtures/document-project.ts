import { LLMock } from "@copilotkit/aimock"

import { toolResultContains } from "./fixture-utils"

/**
 * The model's half of the document-progress test, pinned.
 *
 * The tool itself talks to a real cluster — that is the point of the test — but
 * what the model does either side of it is not what is being measured, and
 * leaving it to a live model made the run fail for reasons that had nothing to
 * do with the bar: a 120b model behind a grammar-constrained endpoint answered
 * a tool-call turn with output the server rejected, and the extension spent ten
 * minutes retrying. So the call and the sign-off are fixtures, and only the
 * document is real.
 */
const TOOL_CALL_ID = "call_document_project_001"

export function addDocumentProjectFixtures(mock: InstanceType<typeof LLMock>) {
	mock.addFixture({
		match: { userMessage: /DOCUMENT_PROGRESS_SMOKE/ },
		response: {
			toolCalls: [
				{
					name: "document_project",
					arguments: JSON.stringify({ path: "docs/manual.docx", source: "." }),
					id: TOOL_CALL_ID,
				},
			],
		},
	})

	mock.addFixture({
		match: {
			predicate: (req) => toolResultContains(req, TOOL_CALL_ID, ["docs/manual.docx"]),
		},
		response: {
			toolCalls: [
				{
					name: "attempt_completion",
					arguments: JSON.stringify({ result: "The documentation is in docs/manual.docx." }),
					id: "call_document_project_002",
				},
			],
		},
	})
}
