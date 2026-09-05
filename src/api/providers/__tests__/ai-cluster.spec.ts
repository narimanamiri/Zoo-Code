// npx vitest run src/api/providers/__tests__/ai-cluster.spec.ts

// Mock vscode first to avoid import errors
vitest.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, defaultValue?: unknown) => defaultValue,
    }),
  },
}));

import { Anthropic } from "@anthropic-ai/sdk";
import OpenAI from "openai";

import { AiClusterHandler } from "../ai-cluster";
import { ApiHandlerOptions } from "../../../shared/api";
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream";
import { clearAllMocks } from "../../../test-utils/reset";

vitest.mock("openai");
vitest.mock("delay", () => ({ default: vitest.fn(() => Promise.resolve()) }));
vitest.mock("../fetchers/modelCache", () => ({
  getModels: vitest.fn().mockImplementation(() =>
    Promise.resolve({
      "gpt-oss-120b": {
        maxTokens: 8192,
        contextWindow: 131072,
        supportsImages: false,
        supportsPromptCache: false,
        supportsReasoningEffort: true,
      },
    }),
  ),
  getModelsFromCache: vitest.fn().mockReturnValue(undefined),
}));

const mockCreate = vitest.fn();

// The OpenAI client is replaced wholesale; these casts describe the mock's
// shape, not the library's.
type MockedOpenAI = {
  mockImplementation: (
    fn: (config?: { baseURL?: string; apiKey?: string }) => unknown,
  ) => void;
  mockClear: () => void;
};
(OpenAI as unknown as MockedOpenAI).mockImplementation(function (config?: {
  baseURL?: string;
  apiKey?: string;
}) {
  return {
    baseURL: config?.baseURL,
    apiKey: config?.apiKey,
    chat: { completions: { create: mockCreate } },
  };
});

const options: ApiHandlerOptions = {
  aiClusterBaseUrl: "http://10.0.0.5:18080/v1",
  aiClusterApiKey: "cluster-key",
  aiClusterModelId: "gpt-oss-120b",
};

const messages: Anthropic.Messages.MessageParam[] = [
  { role: "user", content: "Hi" },
];

const oneChunk = () =>
  asyncStreamFrom([
    {
      choices: [
        {
          delta: { content: "Hello", reasoning_content: "analysis…" },
          index: 0,
        },
      ],
      usage: null,
    },
    {
      choices: [{ delta: {}, index: 0 }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    },
  ]);

describe("AiClusterHandler", () => {
  beforeEach(() => {
    clearAllMocks();
    mockCreate.mockClear();
    mockCreate.mockImplementation(async () => oneChunk());
  });

  it("accepts a base URL with or without the /v1 suffix", () => {
    new AiClusterHandler(options);
    expect(OpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "http://10.0.0.5:18080/v1",
        apiKey: "cluster-key",
      }),
    );
    (OpenAI as unknown as MockedOpenAI).mockClear();
    new AiClusterHandler({
      ...options,
      aiClusterBaseUrl: "http://10.0.0.5:18080",
    });
    expect(OpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "http://10.0.0.5:18080/v1" }),
    );
  });

  it("connects without an API key, as an open LAN deployment has none", () => {
    new AiClusterHandler({ aiClusterBaseUrl: "http://10.0.0.5:18080/v1" });
    expect(OpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "not-provided" }),
    );
  });

  describe("request body", () => {
    it("sends max_tokens, not max_completion_tokens", async () => {
      // The middleware's tool-turn budget floor reads max_tokens; a request
      // carrying only the modern field skipped it entirely.
      const handler = new AiClusterHandler(options);
      await collectStream(handler.createMessage("sys", messages));

      const body = mockCreate.mock.calls[0][0];
      expect(body.max_tokens).toBe(8192);
      expect(body).not.toHaveProperty("max_completion_tokens");
    });

    it("prefers an explicit modelMaxTokens over the model's default", async () => {
      const handler = new AiClusterHandler({
        ...options,
        modelMaxTokens: 2048,
      });
      await collectStream(handler.createMessage("sys", messages));
      expect(mockCreate.mock.calls[0][0].max_tokens).toBe(2048);
    });

    it("omits temperature so the server's per-model default applies", async () => {
      const handler = new AiClusterHandler(options);
      await collectStream(handler.createMessage("sys", messages));
      expect(mockCreate.mock.calls[0][0]).not.toHaveProperty("temperature");
    });

    it("sends temperature when the user chose one", async () => {
      const handler = new AiClusterHandler({
        ...options,
        modelTemperature: 0.2,
      });
      await collectStream(handler.createMessage("sys", messages));
      expect(mockCreate.mock.calls[0][0].temperature).toBe(0.2);
    });

    it("passes reasoning effort as a llama.cpp template argument", async () => {
      const handler = new AiClusterHandler({
        ...options,
        reasoningEffort: "high",
      });
      await collectStream(handler.createMessage("sys", messages));

      const body = mockCreate.mock.calls[0][0];
      expect(body.chat_template_kwargs).toEqual({ reasoning_effort: "high" });
      expect(body).not.toHaveProperty("reasoning_effort");
    });

    it("maps the setting's levels onto the three the template knows", async () => {
      for (const [setting, sent] of [
        ["xhigh", "high"],
        ["max", "high"],
        ["minimal", "low"],
        ["none", "low"],
      ] as const) {
        mockCreate.mockClear();
        const handler = new AiClusterHandler({
          ...options,
          reasoningEffort: setting,
        });
        await collectStream(handler.createMessage("sys", messages));
        expect(mockCreate.mock.calls[0][0].chat_template_kwargs).toEqual({
          reasoning_effort: sent,
        });
      }
    });

    it("sends nothing when reasoning effort is switched off, either way", async () => {
      mockCreate.mockClear();
      await collectStream(
        new AiClusterHandler({
          ...options,
          reasoningEffort: "disable",
        }).createMessage("sys", messages),
      );
      expect(mockCreate.mock.calls[0][0]).not.toHaveProperty(
        "chat_template_kwargs",
      );

      mockCreate.mockClear();
      await collectStream(
        new AiClusterHandler({
          ...options,
          reasoningEffort: "high",
          enableReasoningEffort: false,
        }).createMessage("sys", messages),
      );
      expect(mockCreate.mock.calls[0][0]).not.toHaveProperty(
        "chat_template_kwargs",
      );
    });

    it("sends no template arguments for a model without a thinking channel", async () => {
      const handler = new AiClusterHandler({
        ...options,
        aiClusterModelId: "llama-3-8b",
        reasoningEffort: "high",
      });
      await collectStream(handler.createMessage("sys", messages));
      expect(mockCreate.mock.calls[0][0]).not.toHaveProperty(
        "chat_template_kwargs",
      );
    });

    it("never attaches cache_control blocks to messages", async () => {
      const handler = new AiClusterHandler(options);
      await collectStream(handler.createMessage("sys", messages));
      expect(
        JSON.stringify(mockCreate.mock.calls[0][0].messages),
      ).not.toContain("cache_control");
    });

    it("omits tool fields entirely on a plain chat turn", async () => {
      const handler = new AiClusterHandler(options);
      await collectStream(handler.createMessage("sys", messages));

      const body = mockCreate.mock.calls[0][0];
      expect(body).not.toHaveProperty("tools");
      expect(body).not.toHaveProperty("tool_choice");
      expect(body).not.toHaveProperty("parallel_tool_calls");
    });

    it("sends tools when the task has them", async () => {
      const handler = new AiClusterHandler(options);
      await collectStream(
        handler.createMessage("sys", messages, {
          taskId: "t",
          tools: [
            {
              type: "function",
              function: {
                name: "read_file",
                description: "read",
                parameters: { type: "object" },
              },
            },
          ],
        }) as never,
      );

      const body = mockCreate.mock.calls[0][0];
      expect(body.tools).toHaveLength(1);
      expect(body.tool_choice).toBe("auto");
      expect(body.parallel_tool_calls).toBe(true);
    });

    it("leaves optional tool parameters optional", async () => {
      // The strict-mode rewrite puts every property into `required`, which
      // llama.cpp turns into a grammar demanding all of them — and the model
      // then invents a start_line for every read_file call.
      const handler = new AiClusterHandler(options);
      await collectStream(
        handler.createMessage("sys", messages, {
          taskId: "t",
          tools: [
            {
              type: "function",
              function: {
                name: "read_file",
                description: "read",
                parameters: {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                    start_line: { type: "number" },
                  },
                  required: ["path"],
                },
              },
            },
          ],
        }) as never,
      );

      const tool = mockCreate.mock.calls[0][0].tools[0];
      expect(tool.function.parameters.required).toEqual(["path"]);
      expect(tool.function).not.toHaveProperty("strict");
    });

    it("asks for usage on the stream", async () => {
      const handler = new AiClusterHandler(options);
      await collectStream(handler.createMessage("sys", messages));
      expect(mockCreate.mock.calls[0][0].stream_options).toEqual({
        include_usage: true,
      });
    });
  });

  describe("streaming", () => {
    it("yields text, reasoning and usage", async () => {
      const handler = new AiClusterHandler(options);
      const chunks = await collectStream(
        handler.createMessage("sys", messages),
      );

      expect(chunks).toContainEqual({ type: "text", text: "Hello" });
      expect(chunks).toContainEqual({ type: "reasoning", text: "analysis…" });
      expect(chunks).toContainEqual({
        type: "usage",
        inputTokens: 10,
        outputTokens: 4,
      });
    });

    it("splits inline <think> blocks out of the text", async () => {
      // A build that runs llama.cpp with --reasoning-format none puts the
      // thinking in content; shown as text it reads as the model talking
      // to itself before every answer.
      mockCreate.mockImplementation(async () =>
        asyncStreamFrom([
          { choices: [{ delta: { content: "<think>plan" }, index: 0 }] },
          { choices: [{ delta: { content: "ning</think>Answer" }, index: 0 }] },
        ]),
      );

      const handler = new AiClusterHandler(options);
      const chunks = await collectStream(
        handler.createMessage("sys", messages),
      );

      const reasoning = chunks
        .filter((c) => c.type === "reasoning")
        .map((c) => (c as { text: string }).text);
      const text = chunks
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text);
      expect(reasoning.join("")).toBe("planning");
      expect(text.join("")).toBe("Answer");
    });

    it("closes tool calls on finish_reason, which llama.cpp does not always do itself", async () => {
      mockCreate.mockImplementation(async () =>
        asyncStreamFrom([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      function: { name: "read_file", arguments: "{}" },
                    },
                  ],
                },
                index: 0,
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] },
        ]),
      );

      const handler = new AiClusterHandler(options);
      const chunks = await collectStream(
        handler.createMessage("sys", messages),
      );

      expect(chunks).toContainEqual({
        type: "tool_call_partial",
        index: 0,
        id: "call_1",
        name: "read_file",
        arguments: "{}",
      });
      expect(chunks).toContainEqual({ type: "tool_call_end", id: "call_1" });
    });
  });

  describe("errors", () => {
    const failWith = (error: unknown) => {
      mockCreate.mockImplementation(async () => {
        throw error;
      });
    };

    it("names the address when the node is unreachable", async () => {
      failWith(
        Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        }),
      );
      const handler = new AiClusterHandler(options);
      await expect(
        collectStream(handler.createMessage("sys", messages)),
      ).rejects.toThrow(/unreachable at http:\/\/10\.0\.0\.5:18080\/v1/);
    });

    it("finds the refused connection the SDK buried under cause", async () => {
      // openai-node reports "Connection error." with an empty code; the
      // ECONNREFUSED sits on `cause`, and under fetch's happy-eyeballs on an
      // AggregateError below that. The first version read only the top.
      const inner = Object.assign(
        new Error("connect ECONNREFUSED 10.0.0.5:18080"),
        { code: "ECONNREFUSED" },
      );
      const aggregate = Object.assign(new Error("fetch failed"), {
        errors: [inner],
      });
      failWith(
        Object.assign(new Error("Connection error."), { cause: aggregate }),
      );

      const handler = new AiClusterHandler(options);
      await expect(
        collectStream(handler.createMessage("sys", messages)),
      ).rejects.toThrow(/unreachable/);
    });

    it("says what to raise when the request times out", async () => {
      failWith(
        Object.assign(new Error("Request timed out."), { code: "ETIMEDOUT" }),
      );
      const handler = new AiClusterHandler(options);
      await expect(
        collectStream(handler.createMessage("sys", messages)),
      ).rejects.toThrow(/request timeout/);
    });

    it("explains a full queue rather than repeating the status code", async () => {
      failWith(
        Object.assign(new Error("server busy, try again"), { status: 503 }),
      );
      const handler = new AiClusterHandler(options);
      await expect(
        collectStream(handler.createMessage("sys", messages)),
      ).rejects.toThrow(/busy/);
    });

    it("points at the /v1 suffix on a 404", async () => {
      failWith(Object.assign(new Error("Not Found"), { status: 404 }));
      const handler = new AiClusterHandler(options);
      await expect(
        collectStream(handler.createMessage("sys", messages)),
      ).rejects.toThrow(/\/v1/);
    });

    it("reports a mid-stream failure with the same wording", async () => {
      mockCreate.mockImplementation(async () => ({
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: "part" }, index: 0 }] };
          throw Object.assign(new Error("server busy, try again"), {
            status: 503,
          });
        },
      }));

      const handler = new AiClusterHandler(options);
      await expect(
        collectStream(handler.createMessage("sys", messages)),
      ).rejects.toThrow(/busy/);
    });
  });

  describe("completePrompt", () => {
    it("returns the message content", async () => {
      mockCreate.mockImplementation(async () => ({
        choices: [{ message: { content: "done" } }],
      }));
      const handler = new AiClusterHandler(options);
      expect(await handler.completePrompt("hi")).toBe("done");
      expect(mockCreate.mock.calls[0][0].stream).toBe(false);
    });
  });
});
