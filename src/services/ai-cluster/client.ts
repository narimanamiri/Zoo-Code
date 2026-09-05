import axios from "axios";
import { z } from "zod";

import { aiClusterOrigin } from "../../api/providers/fetchers/ai-cluster";

/**
 * The cluster's non-inference surfaces: the skills it has installed, and what
 * the deployment says it can do. Both live on the same host as /v1/chat, which
 * is the whole reason this integration needs no second address.
 */

const skillFileSchema = z.object({
  path: z.string(),
  bytes: z.number().optional(),
  // Text files come inline; anything binary or oversized arrives as a path
  // only and has to be fetched separately.
  text: z.string().optional(),
});

const skillSummarySchema = z.object({
  name: z.string(),
  dirname: z.string().optional(),
  description: z.string().default(""),
  triggers: z.string().optional(),
  runs_on: z.string().optional(),
  digest: z.string().optional(),
  files: z.array(skillFileSchema).default([]),
});

const skillDetailSchema = skillSummarySchema.extend({
  content: z.string(),
});

const skillListSchema = z.object({
  data: z.array(skillSummarySchema),
  skills_dir: z.string().optional(),
  count: z.number().optional(),
});

export type ClusterSkillSummary = z.infer<typeof skillSummarySchema>;
export type ClusterSkillDetail = z.infer<typeof skillDetailSchema>;

export type ClusterCredentials = {
  baseUrl: string;
  apiKey?: string;
};

const headers = (apiKey?: string): Record<string, string> =>
  apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

/** `http://host:18080/v1` → `http://host:18080/mcp`. */
export const aiClusterMcpUrl = (baseUrl: string): string =>
  `${aiClusterOrigin(baseUrl)}/mcp`;

/**
 * Skills installed on the cluster.
 *
 * Throws on failure, unlike the model fetcher: a sync is something the user
 * asked for (or that runs on a schedule and reports), so silence would leave
 * them staring at an empty list with no reason for it.
 */
export async function fetchClusterSkills({
  baseUrl,
  apiKey,
}: ClusterCredentials): Promise<ClusterSkillSummary[]> {
  const response = await axios.get(`${aiClusterOrigin(baseUrl)}/v1/skills`, {
    headers: headers(apiKey),
    timeout: 15_000,
  });
  return skillListSchema.parse(response.data).data;
}

export async function fetchClusterSkill(
  { baseUrl, apiKey }: ClusterCredentials,
  name: string,
): Promise<ClusterSkillDetail> {
  const response = await axios.get(
    `${aiClusterOrigin(baseUrl)}/v1/skills/${encodeURIComponent(name)}`,
    {
      headers: headers(apiKey),
      timeout: 30_000,
    },
  );
  return skillDetailSchema.parse(response.data);
}

export type ClusterDocumentRequest = {
  brief?: string;
  spec?: Record<string, unknown>;
  format: "pdf" | "docx" | "pptx";
  appendBlocks?: Array<Record<string, unknown>>;
  lang?: string;
  title?: string;
  author?: string;
  org?: string;
  date?: string;
  deck?: boolean;
  timeoutMs?: number;
};

/** Where the cluster has got to. `percent` is 0–100 and never goes backwards. */
export type ClusterDocumentProgress = {
  percent: number;
  stage: string;
  message: string;
};

/**
 * Build a document on the cluster and return its bytes.
 *
 * `?download=1` so the reply is the file itself rather than JSON carrying
 * base64: the caller is writing it to disk, and a link the user has to fetch by
 * hand is the step this exists to remove.
 *
 * The format lives in the path rather than the body. A JSON field a model reads
 * as optional gets dropped, and the cluster then defaults to PDF — which is how
 * a PDF ends up saved as .docx and reported by Word as corrupt.
 */
export async function buildClusterDocument(
  { baseUrl, apiKey }: ClusterCredentials,
  request: ClusterDocumentRequest,
  onProgress?: (progress: ClusterDocumentProgress) => void,
): Promise<Buffer> {
  if (onProgress) {
    const streamed = await streamClusterDocument(
      { baseUrl, apiKey },
      request,
      onProgress,
    );
    if (streamed) {
      return streamed;
    }
    // The cluster is an older build with no progress stream. Fall through to
    // the buffered request rather than failing over something cosmetic.
  }
  const body = documentBody(request);

  const response = await axios.post(
    `${aiClusterOrigin(baseUrl)}/v1/documents/${request.format}?download=1`,
    body,
    {
      headers: { ...headers(apiKey), "Content-Type": "application/json" },
      responseType: "arraybuffer",
      // A long document is planned and then written a section at a time,
      // which is minutes of work rather than seconds.
      timeout: request.timeoutMs ?? 30 * 60_000,
      // A refusal arrives as 400 with an explanation worth showing, so it
      // is read here instead of thrown as a bare "Request failed".
      validateStatus: () => true,
      maxContentLength: 128 * 1024 * 1024,
      maxBodyLength: 128 * 1024 * 1024,
    },
  );

  const buffer = Buffer.from(response.data);
  if (response.status >= 400) {
    let message = `the cluster refused the request (HTTP ${response.status})`;
    // For ?download=1 a refusal comes back as a rendered document explaining
    // itself — readable by whoever opens it, useless to a program. The same
    // reason is repeated in a header for exactly this reason.
    const header = response.headers?.["x-document-refused"];
    if (typeof header === "string" && header.trim()) {
      message = header.trim();
    } else {
      try {
        const parsed = JSON.parse(buffer.toString("utf8"));
        message = parsed?.error?.message ?? message;
      } catch {
        message += ", and returned an explanation in place of the document";
      }
    }
    throw new Error(message);
  }
  if (!buffer.length) {
    throw new Error("the cluster returned an empty document");
  }
  return buffer;
}

function documentBody(
  request: ClusterDocumentRequest,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (request.brief) {
    body.brief = request.brief;
  }
  if (request.spec) {
    body.spec = request.spec;
  }
  if (request.appendBlocks?.length) {
    body.append_blocks = request.appendBlocks;
  }
  for (const key of ["lang", "title", "author", "org", "date"] as const) {
    const value = request[key];
    if (value) {
      body[key] = value;
    }
  }
  if (request.deck) {
    body.deck = true;
  }
  return body;
}

/**
 * The same document, asked for as a stream of progress events.
 *
 * Writing one takes minutes, and a buffered POST says nothing at all until it
 * says everything — so the extension could only show a spinner, and a slow
 * document looked exactly like a dead cluster. Here the cluster reports each
 * stage as it reaches it and sends the file in the last event.
 *
 * Returns null when this cluster does not stream, so the caller can fall back
 * instead of failing: the progress bar is worth having, not worth an error.
 */
async function streamClusterDocument(
  { baseUrl, apiKey }: ClusterCredentials,
  request: ClusterDocumentRequest,
  onProgress: (progress: ClusterDocumentProgress) => void,
): Promise<Buffer | null> {
  const response = await axios.post(
    `${aiClusterOrigin(baseUrl)}/v1/documents/${request.format}?stream=1`,
    documentBody(request),
    {
      headers: {
        ...headers(apiKey),
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      responseType: "stream",
      // Between events, not for the whole document: the stream is never
      // quiet for long, so this is a real liveness check rather than the
      // half-hour ceiling the buffered call has to use.
      timeout: request.timeoutMs ?? 10 * 60_000,
      validateStatus: () => true,
      maxContentLength: 128 * 1024 * 1024,
      maxBodyLength: 128 * 1024 * 1024,
    },
  );

  const contentType = String(response.headers?.["content-type"] ?? "");
  if (response.status >= 400) {
    response.data?.destroy?.();
    // A refusal names its reason in a header (the body may be a rendered
    // document). Raising it here saves a second, identical refusal from
    // the buffered fallback — measured as two DocForge runs per refusal.
    const refused = response.headers?.["x-document-refused"];
    if (typeof refused === "string" && refused.trim()) {
      throw new Error(refused.trim());
    }
    return null;
  }
  if (!contentType.includes("text/event-stream")) {
    response.data?.destroy?.();
    return null;
  }

  let document: Buffer | null = null;
  let failure: string | null = null;
  let highest = 0;

  // axios's timeout only covers the wait for headers, and the first event
  // arrives at once — so on its own it never fires. The liveness check the
  // comment above promises is this: silence between events for that long
  // means the connection is dead, not that the document is slow.
  const idleMs = request.timeoutMs ?? 10 * 60_000;
  for await (const frame of sseFrames(
    response.data as NodeJS.ReadableStream,
    idleMs,
  )) {
    if (frame.event === "progress") {
      const percent = Number(frame.data?.percent);
      // Monotonic: a retry reports the percentage of the section it is
      // redoing, and a bar that jumps backwards reads as a fault.
      highest = Math.max(highest, Number.isFinite(percent) ? percent : 0);
      onProgress({
        percent: highest,
        stage: String(frame.data?.stage ?? ""),
        message: String(frame.data?.message ?? ""),
      });
    } else if (frame.event === "result") {
      const encoded = frame.data?.content_base64;
      if (typeof encoded === "string" && encoded.length) {
        document = Buffer.from(encoded, "base64");
      }
    } else if (frame.event === "error") {
      const detail = (frame.data?.error ?? {}) as { message?: string };
      failure = detail.message ?? "the cluster could not write the document";
    }
  }

  if (failure) {
    throw new Error(failure);
  }
  if (!document?.length) {
    // The stream ended without the file — a dropped connection, or a
    // document too large to inline. Neither is worth guessing about.
    return null;
  }
  return document;
}

/** An event's payload is whatever the cluster put in it; each reader checks. */
type SseFrame = { event: string; data: Record<string, unknown> };

/**
 * Server-sent events off a Node stream, one decoded frame at a time.
 *
 * `idleMs` bounds the silence between chunks: past it the stream is destroyed
 * with an error, which surfaces through the loop as a rejection the caller can
 * report. Zero or undefined means wait forever.
 */
async function* sseFrames(
  stream: NodeJS.ReadableStream,
  idleMs?: number,
): AsyncGenerator<SseFrame> {
  let buffer = "";
  const destroyable = stream as NodeJS.ReadableStream & {
    destroy?: (error?: Error) => void;
  };
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (!idleMs) {
      return;
    }
    if (watchdog) {
      clearTimeout(watchdog);
    }
    watchdog = setTimeout(() => {
      destroyable.destroy?.(
        new Error(
          `no progress from the cluster for ${Math.round(idleMs / 1000)}s; the connection was dropped`,
        ),
      );
    }, idleMs);
    watchdog.unref?.();
  };

  arm();
  try {
    for await (const chunk of stream) {
      arm();
      buffer += chunk.toString();
      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        const raw = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf("\n\n");

        let event = "message";
        const payload: string[] = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) {
            event = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            payload.push(line.slice(5).trim());
          }
        }
        if (!payload.length) {
          continue;
        }
        try {
          yield { event, data: JSON.parse(payload.join("\n")) };
        } catch {
          // A frame we cannot read is one missed bar update, not a failure.
        }
      }
    }
  } finally {
    if (watchdog) {
      clearTimeout(watchdog);
    }
  }
}

/** One bundled file the list did not inline (binary, or over the size limit). */
export async function fetchClusterSkillFile(
  { baseUrl, apiKey }: ClusterCredentials,
  name: string,
  filePath: string,
): Promise<Buffer> {
  const encoded = filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const response = await axios.get(
    `${aiClusterOrigin(baseUrl)}/v1/skills/${encodeURIComponent(name)}/files/${encoded}`,
    { headers: headers(apiKey), responseType: "arraybuffer", timeout: 30_000 },
  );
  return Buffer.from(response.data);
}
