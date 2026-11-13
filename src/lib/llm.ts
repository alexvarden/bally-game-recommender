/**
 * One function for "ask an LLM for JSON matching this zod schema", over whichever provider is configured.
 *
 *   OPENROUTER_API_KEY → OpenRouter chat completions with a strict json_schema response format
 *   ANTHROPIC_API_KEY  → Anthropic SDK structured outputs
 *
 * The response is always validated with zod here, whatever the provider promised.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

export type Provider = "openrouter" | "anthropic";

export interface StructuredRequest<T extends z.ZodType> {
  schema: T;
  /** Short identifier for the schema; some providers require one. */
  schemaName: string;
  system: string;
  user: string;
  /** Model id without provider prefix, e.g. "claude-opus-5-5". Mapped per provider. */
  model: string;
  maxTokens?: number;
}

export interface StructuredResponse<T> {
  data: T;
  provider: Provider;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export class LlmError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

export function configuredProvider(): Provider {
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  throw new LlmError("No LLM credentials: set OPENROUTER_API_KEY or ANTHROPIC_API_KEY in .env", false);
}

/** "claude-opus-5-5" → "anthropic/claude-opus-5.5". Ids that already contain a "/" pass through. */
export function openRouterModelId(model: string) {
  if (model.includes("/")) return model;
  const m = model.match(/^(claude-[a-z]+)-(\d+)(?:-(\d+))?$/);
  return m ? `anthropic/${m[1]}-${m[2]}${m[3] ? `.${m[3]}` : ""}` : model;
}

export async function generateStructured<T extends z.ZodType>(req: StructuredRequest<T>): Promise<StructuredResponse<z.infer<T>>> {
  const provider = configuredProvider();
  return provider === "openrouter" ? viaOpenRouter(req) : viaAnthropic(req);
}

// ---------- OpenRouter ----------

async function viaOpenRouter<T extends z.ZodType>(req: StructuredRequest<T>): Promise<StructuredResponse<z.infer<T>>> {
  const model = openRouterModelId(req.model);
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "bally-game-recommender",
    },
    body: JSON.stringify({
      model,
      max_tokens: req.maxTokens ?? 16000,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: req.schemaName, strict: true, schema: z.toJSONSchema(req.schema, { target: "draft-7" }) },
      },
      // Only route to providers that honour the schema, rather than silently ignoring it.
      provider: { require_parameters: true },
    }),
    signal: AbortSignal.timeout(10 * 60_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new LlmError(`OpenRouter ${res.status}: ${body.slice(0, 500)}`, res.status === 429 || res.status >= 500);
  }
  const json = (await res.json()) as {
    model: string;
    choices?: { finish_reason: string; message: { content: string | null; refusal?: string | null } }[];
    usage?: { prompt_tokens: number; completion_tokens: number };
    error?: { message: string };
  };
  if (json.error) throw new LlmError(`OpenRouter error: ${json.error.message}`, true);
  const choice = json.choices?.[0];
  if (!choice) throw new LlmError("OpenRouter returned no choices", true);
  if (choice.message.refusal) throw new LlmError(`refused: ${choice.message.refusal}`, false);
  if (choice.finish_reason === "length") throw new LlmError("hit max_tokens", true);

  let parsed: unknown;
  try {
    parsed = JSON.parse(choice.message.content ?? "");
  } catch {
    throw new LlmError(`response was not JSON: ${(choice.message.content ?? "").slice(0, 200)}`, true);
  }
  const result = req.schema.safeParse(parsed);
  if (!result.success) throw new LlmError(`response failed schema: ${result.error.message.slice(0, 500)}`, true);
  return {
    data: result.data,
    provider: "openrouter",
    model: json.model,
    usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 },
  };
}

// ---------- Anthropic ----------

let anthropic: Anthropic | undefined;

async function viaAnthropic<T extends z.ZodType>(req: StructuredRequest<T>): Promise<StructuredResponse<z.infer<T>>> {
  anthropic ??= new Anthropic();
  const response = await anthropic.beta.messages.parse({
    model: req.model,
    max_tokens: req.maxTokens ?? 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: betaZodOutputFormat(req.schema) },
    system: req.system,
    messages: [{ role: "user", content: req.user }],
  });
  if (response.stop_reason === "refusal") throw new LlmError(`refused: ${response.stop_details?.category ?? "unknown"}`, false);
  if (response.stop_reason === "max_tokens") throw new LlmError("hit max_tokens", true);
  if (!response.parsed_output) throw new LlmError("no parsed output", true);
  const result = req.schema.safeParse(response.parsed_output);
  if (!result.success) throw new LlmError(`response failed schema: ${result.error.message.slice(0, 500)}`, true);
  return {
    data: result.data,
    provider: "anthropic",
    model: response.model,
    usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
  };
}
