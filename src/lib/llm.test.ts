import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const anthropicParse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    beta = { messages: { parse: anthropicParse } };
  },
}));

const { configuredProvider, contentOf, generateStructured, LlmError, openRouterBody, openRouterModelId, parseStructured } = await import("./llm.ts");

const Schema = z.object({ answer: z.string(), score: z.number().nullable() });
const request = { schema: Schema, schemaName: "t", system: "sys", user: "hi", model: "claude-opus-5-5" };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("configuredProvider", () => {
  it("prefers OpenRouter, falls back to Anthropic, and errors with neither", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "x");
    vi.stubEnv("ANTHROPIC_API_KEY", "y");
    expect(configuredProvider()).toBe("openrouter");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    expect(configuredProvider()).toBe("anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(() => configuredProvider()).toThrow(/No LLM credentials/);
  });
});

describe("openRouterModelId", () => {
  it("maps Anthropic ids and passes provider-qualified ids through", () => {
    expect(openRouterModelId("claude-opus-5-5")).toBe("anthropic/claude-opus-5.5");
    expect(openRouterModelId("claude-sonnet-5")).toBe("anthropic/claude-sonnet-5");
    expect(openRouterModelId("openai/gpt-6-luna")).toBe("openai/gpt-6-luna");
    expect(openRouterModelId("mystery")).toBe("mystery");
  });
});

describe("openRouterBody", () => {
  it("sends a strict JSON schema and requires providers that honour it", () => {
    const body = openRouterBody(request);
    expect(body.model).toBe("anthropic/claude-opus-5.5");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema).toMatchObject({ type: "object", required: ["answer", "score"], additionalProperties: false });
    expect(body.provider.require_parameters).toBe(true);
    expect(body.max_tokens).toBe(16000);
  });
});

describe("contentOf", () => {
  const ok = (over: object = {}) => ({ model: "m", choices: [{ finish_reason: "stop", message: { content: "{}", ...over } }] });

  it("returns content from a normal completion", () => expect(contentOf(ok())).toBe("{}"));

  it.each([
    ["an error body", { model: "m", error: { message: "boom" } }, true],
    ["no choices", { model: "m", choices: [] }, true],
    ["a refusal", ok({ refusal: "no" }), false],
    ["truncation", { model: "m", choices: [{ finish_reason: "length", message: { content: "{" } }] }, true],
  ])("throws on %s, marking retryability", (_, json, retryable) => {
    try {
      contentOf(json);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError);
      expect((err as InstanceType<typeof LlmError>).retryable).toBe(retryable);
    }
  });
});

describe("parseStructured", () => {
  it("returns validated data", () => expect(parseStructured(Schema, '{"answer":"a","score":null}')).toEqual({ answer: "a", score: null }));
  it("rejects non-JSON and schema violations as retryable", () => {
    expect(() => parseStructured(Schema, "nope")).toThrow(/not JSON/);
    expect(() => parseStructured(Schema, '{"answer":1}')).toThrow(/failed schema/);
  });
});

describe("generateStructured", () => {
  it("calls OpenRouter and validates the response", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "key");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ model: "anthropic/claude-opus-5.5", choices: [{ finish_reason: "stop", message: { content: '{"answer":"ok","score":1}' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await generateStructured(request);
    expect(res).toEqual({ data: { answer: "ok", score: 1 }, provider: "openrouter", model: "anthropic/claude-opus-5.5", usage: { inputTokens: 3, outputTokens: 4 } });
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe("Bearer key");
  });

  it("marks HTTP 429/5xx retryable and 4xx not", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("slow down", { status: 429 })).mockResolvedValueOnce(new Response("no credit", { status: 402 })));
    await expect(generateStructured(request)).rejects.toMatchObject({ retryable: true });
    await expect(generateStructured(request)).rejects.toMatchObject({ retryable: false });
  });

  it("uses the Anthropic SDK when only that key is set, and maps refusals and truncation", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "key");
    const base = { model: "claude-opus-5-5", usage: { input_tokens: 5, output_tokens: 6 }, stop_details: null };
    anthropicParse
      .mockResolvedValueOnce({ ...base, stop_reason: "end_turn", parsed_output: { answer: "a", score: null } })
      .mockResolvedValueOnce({ ...base, stop_reason: "refusal", stop_details: { category: "cyber" } })
      .mockResolvedValueOnce({ ...base, stop_reason: "max_tokens" })
      .mockResolvedValueOnce({ ...base, stop_reason: "end_turn", parsed_output: null });

    await expect(generateStructured(request)).resolves.toMatchObject({ data: { answer: "a" }, provider: "anthropic", usage: { inputTokens: 5 } });
    await expect(generateStructured(request)).rejects.toMatchObject({ retryable: false, message: "refused: cyber" });
    await expect(generateStructured(request)).rejects.toMatchObject({ retryable: true, message: "hit max_tokens" });
    await expect(generateStructured(request)).rejects.toMatchObject({ retryable: true, message: "no parsed output" });
    expect(anthropicParse.mock.calls[0]![0]).toMatchObject({ fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
  });
});
