import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import type { BaseModelId, ThinkingLevelOption } from '../src/types/engine.ts';

let cachedClient: GoogleGenAI | null = null;

export function isGeminiApiKeyConfigured(): boolean {
  const apiKey = process.env.GEMINI_API_KEY;
  return Boolean(apiKey && apiKey.trim().length > 0 && apiKey !== 'MY_GEMINI_API_KEY');
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error(
      'Ключ GEMINI_API_KEY не задан на сервере. Проверьте настройки секретов окружения.'
    );
  }
  if (!cachedClient) {
    cachedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return cachedClient;
}

export interface OpenAiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GeminiTextRequest {
  baseModel: 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite';
  messages: OpenAiChatMessage[];
  defaultSystemInstruction?: string;
  thinkingLevel?: ThinkingLevelOption;
}

export interface GeminiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface GeminiStreamChunk {
  text: string;
  usage?: GeminiUsage;
}

function mapThinkingLevel(level?: ThinkingLevelOption): ThinkingLevel {
  if (level === 'HIGH') return ThinkingLevel.HIGH;
  if (level === 'MEDIUM') return ThinkingLevel.MEDIUM;
  return ThinkingLevel.LOW;
}

function formatMessagesToPrompt(
  messages: OpenAiChatMessage[],
  defaultSystemInstruction?: string
): {
  systemInstruction: string | undefined;
  contents: string;
} {
  const systemParts: string[] = [];
  if (defaultSystemInstruction && defaultSystemInstruction.trim().length > 0) {
    systemParts.push(defaultSystemInstruction.trim());
  }
  const dialogueParts: string[] = [];

  for (const msg of messages) {
    const text = typeof msg.content === 'string' ? msg.content : String(msg.content ?? '');
    if (msg.role === 'system') {
      if (text.trim()) systemParts.push(text.trim());
    } else if (msg.role === 'assistant') {
      dialogueParts.push(`Assistant: ${text}`);
    } else {
      dialogueParts.push(`User: ${text}`);
    }
  }

  const nonSystemMessages = messages.filter((m) => m.role !== 'system');
  const contents =
    nonSystemMessages.length === 1 && nonSystemMessages[0]?.role === 'user'
      ? String(nonSystemMessages[0].content ?? '')
      : dialogueParts.join('\n\n');

  return {
    systemInstruction: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    contents: contents || 'Привет!',
  };
}

export function formatGeminiError(err: unknown): { status: number; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.includes('GEMINI_API_KEY')) {
    return { status: 503, message: raw };
  }
  if (raw.includes('403') || raw.includes('PERMISSION_DENIED') || raw.includes('API_KEY_INVALID')) {
    return {
      status: 403,
      message:
        'Ошибка доступа к Gemini API (403/API_KEY_INVALID). Проверьте ключ API в разделе Settings > Secrets.',
    };
  }
  if (raw.includes('429') || raw.includes('RESOURCE_EXHAUSTED')) {
    return {
      status: 429,
      message:
        'Превышена квота Gemini API (429 RESOURCE_EXHAUSTED). Повторите запрос позже или проверьте квоту в Settings > Secrets.',
    };
  }
  if (raw.includes('404') || raw.includes('NOT_FOUND')) {
    return {
      status: 404,
      message: `Модель не найдена в Gemini API (404): ${raw}`,
    };
  }
  return { status: 500, message: `Ошибка серверного инференса: ${raw}` };
}

export async function* streamGeminiText(
  req: GeminiTextRequest
): AsyncGenerator<GeminiStreamChunk, void, unknown> {
  const ai = getGeminiClient();
  const { systemInstruction, contents } = formatMessagesToPrompt(
    req.messages,
    req.defaultSystemInstruction
  );

  const responseStream = await ai.models.generateContentStream({
    model: req.baseModel,
    contents,
    config: {
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(req.baseModel === 'gemini-4-hydrogen'
        ? { thinkingConfig: { thinkingLevel: mapThinkingLevel(req.thinkingLevel) } }
        : {}),
    },
  });

  for await (const chunk of responseStream) {
    const text = chunk.text ?? '';
    const meta = chunk.usageMetadata;
    const usage =
      meta && (meta.promptTokenCount || meta.candidatesTokenCount || meta.totalTokenCount)
        ? {
            promptTokens: meta.promptTokenCount ?? 0,
            completionTokens: meta.candidatesTokenCount ?? 0,
            totalTokens: meta.totalTokenCount ?? 0,
          }
        : undefined;

    if (text || usage) {
      yield { text, usage };
    }
  }
}

export async function generateGeminiText(
  req: GeminiTextRequest
): Promise<{ text: string; usage: GeminiUsage }> {
  const ai = getGeminiClient();
  const { systemInstruction, contents } = formatMessagesToPrompt(
    req.messages,
    req.defaultSystemInstruction
  );

  const response = await ai.models.generateContent({
    model: req.baseModel,
    contents,
    config: {
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(req.baseModel === 'gemini-4-hydrogen'
        ? { thinkingConfig: { thinkingLevel: mapThinkingLevel(req.thinkingLevel) } }
        : {}),
    },
  });

  const text = response.text ?? '';
  const meta = response.usageMetadata;
  const usage: GeminiUsage = {
    promptTokens: meta?.promptTokenCount ?? 0,
    completionTokens: meta?.candidatesTokenCount ?? 0,
    totalTokens: meta?.totalTokenCount ?? 0,
  };

  return { text, usage };
}

export async function generateGeminiEmbeddings(
  inputs: string[]
): Promise<{ embeddings: number[][]; totalTokens: number }> {
  const ai = getGeminiClient();
  const result = await ai.models.embedContent({
    model: 'gemini-embedding-2',
    contents: inputs,
  });

  const vectors = (result.embeddings ?? []).map((e) => e.values ?? []);
  const totalTokens = inputs.reduce((sum, s) => sum + Math.max(1, Math.ceil(s.length / 4)), 0);
  return { embeddings: vectors, totalTokens };
}

export async function probeModelReadiness(baseModel: BaseModelId): Promise<void> {
  const ai = getGeminiClient();
  if (baseModel === 'gemini-embedding-2') {
    await ai.models.embedContent({
      model: 'gemini-embedding-2',
      contents: ['ping'],
    });
    return;
  }
  await ai.models.generateContent({
    model: baseModel,
    contents: 'Ответь одним словом: OK',
    config:
      baseModel === 'gemini-4-hydrogen'
        ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
        : undefined,
  });
}
