import type { Content, Part } from '@google/genai';
import type { AgentToolStep, ModelDeployment } from '../src/types/engine.ts';
import type { ModelServerRuntime } from './engine.ts';
import { formatGeminiError, getGeminiClient, mapThinkingLevel, type OpenAiChatMessage } from './gemini.ts';
import { getGgufProcessPort } from './ggufRunner.ts';
import {
  buildAgentSystemGuidance,
  executeWorkspaceTool,
  getAccessConfig,
  getGeminiWorkspaceToolDeclarations,
  getOpenAiWorkspaceTools,
} from './workspaceTools.ts';

export type AgentSseEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; step: AgentToolStep }
  | { type: 'tool_result'; step: AgentToolStep }
  | {
      type: 'done';
      ttftMs: number;
      totalMs: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      tokensPerSec: number | null;
      stepsCount: number;
    }
  | { type: 'error'; message: string };

interface ParsedOpenAiToolCall {
  id: string;
  name: string;
  argumentsRaw: string;
}

function parseFallbackXmlToolCalls(text: string): {
  cleanedText: string;
  calls: ParsedOpenAiToolCall[];
} {
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  const calls: ParsedOpenAiToolCall[] = [];
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]) as {
        name?: string;
        arguments?: unknown;
      };
      if (typeof parsed.name === 'string' && parsed.name.trim()) {
        calls.push({
          id: `call_fallback_${Date.now()}_${idx++}`,
          name: parsed.name.trim(),
          argumentsRaw:
            typeof parsed.arguments === 'string'
              ? parsed.arguments
              : JSON.stringify(parsed.arguments ?? {}),
        });
      }
    } catch {
      // Ignore malformed tag
    }
  }

  const cleanedText = calls.length > 0 ? text.replace(regex, '').trim() : text;
  return { cleanedText, calls };
}

function safeParseJsonObject(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function runAgentChatStream(params: {
  engine: ModelServerRuntime;
  deployment: ModelDeployment;
  messages: OpenAiChatMessage[];
  userSystemPrompt?: string;
  enableTools: boolean;
  signal: AbortSignal;
  emit: (evt: AgentSseEvent) => void;
}): Promise<void> {
  const { engine, deployment, messages, userSystemPrompt, enableTools, signal, emit } = params;
  const accessCfg = getAccessConfig();
  const toolsActive = Boolean(enableTools && accessCfg.enabled);
  const maxIterations = Math.max(1, accessCfg.maxToolIterations || 8);

  const lastUserMsg =
    [...messages].reverse().find((m) => m.role === 'user')?.content ??
    messages[messages.length - 1]?.content ??
    '';
  const promptChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);

  const record = engine.createRequestRecord({
    deployment,
    endpoint: '/v1/chat/completions',
    stream: true,
    promptPreview: String(lastUserMsg),
    systemPrompt: userSystemPrompt,
    promptCharCount: promptChars,
  });

  const startedAt = performance.now();
  let ttftMs: number | null = null;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalAllTokens = 0;
  let totalGeneratedText = '';
  let stepsCount = 0;

  await engine.acquireSlot(deployment.id, record);

  try {
    const combinedSystem = buildAgentSystemGuidance(
      toolsActive ? accessCfg : { ...accessCfg, enabled: false },
      [deployment.systemInstruction, userSystemPrompt].filter(Boolean).join('\n\n')
    );

    if (deployment.provider === 'local_gguf') {
      const port = getGgufProcessPort(deployment.id);
      const openAiTools = toolsActive ? getOpenAiWorkspaceTools(accessCfg) : [];
      const history: Array<Record<string, unknown>> = [];
      if (combinedSystem.trim()) {
        history.push({ role: 'system', content: combinedSystem.trim() });
      }
      for (const m of messages) {
        if (m.role !== 'system') {
          history.push({ role: m.role, content: m.content });
        }
      }

      for (let iter = 0; iter < maxIterations; iter++) {
        if (signal.aborted) break;

        const payload: Record<string, unknown> = {
          messages: history,
          stream: true,
          stream_options: { include_usage: true },
          temperature: 0.4,
        };
        if (openAiTools.length > 0) {
          payload.tools = openAiTools;
          payload.tool_choice = 'auto';
        }

        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal,
          body: JSON.stringify(payload),
        });

        if (!res.ok || !res.body) {
          const errText = await res.text().catch(() => '');
          throw new Error(`llama-server HTTP ${res.status}: ${errText || res.statusText}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let stepText = '';
        const toolCallBuilders = new Map<number, ParsedOpenAiToolCall>();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line.startsWith('data:')) continue;
            const dataStr = line.slice(5).trim();
            if (dataStr === '[DONE]') continue;

            try {
              const parsed = JSON.parse(dataStr) as {
                choices?: Array<{
                  delta?: {
                    content?: string;
                    tool_calls?: Array<{
                      index?: number;
                      id?: string;
                      function?: { name?: string; arguments?: string };
                    }>;
                  };
                }>;
                usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
              };

              const delta = parsed.choices?.[0]?.delta;
              if (delta?.content) {
                if (ttftMs === null) ttftMs = Math.round(performance.now() - startedAt);
                stepText += delta.content;
                totalGeneratedText += delta.content;
                engine.appendStreamTokens(record, delta.content);
                emit({ type: 'text', delta: delta.content });
              }

              if (Array.isArray(delta?.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  const existing = toolCallBuilders.get(idx) ?? {
                    id: tc.id || `call_${iter}_${idx}`,
                    name: '',
                    argumentsRaw: '',
                  };
                  if (tc.id) existing.id = tc.id;
                  if (tc.function?.name) existing.name += tc.function.name;
                  if (tc.function?.arguments) existing.argumentsRaw += tc.function.arguments;
                  toolCallBuilders.set(idx, existing);
                }
              }

              if (parsed.usage) {
                totalPromptTokens += parsed.usage.prompt_tokens ?? 0;
                totalCompletionTokens += parsed.usage.completion_tokens ?? 0;
                totalAllTokens += parsed.usage.total_tokens ?? 0;
              }
            } catch {
              // ignore partial SSE JSON
            }
          }
        }

        let pendingCalls = Array.from(toolCallBuilders.values()).filter((c) => c.name.trim());
        if (pendingCalls.length === 0 && toolsActive && stepText.includes('<tool_call>')) {
          const fallback = parseFallbackXmlToolCalls(stepText);
          if (fallback.calls.length > 0) {
            pendingCalls = fallback.calls;
          }
        }

        if (pendingCalls.length === 0 || !toolsActive) {
          break;
        }

        history.push({
          role: 'assistant',
          content: stepText || null,
          tool_calls: pendingCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.argumentsRaw || '{}' },
          })),
        });

        for (const call of pendingCalls) {
          if (signal.aborted) break;
          const argsObj = safeParseJsonObject(call.argumentsRaw);
          const stepId = `step-${Date.now().toString(36)}-${stepsCount++}`;
          const runningStep: AgentToolStep = {
            id: stepId,
            toolName: call.name,
            args: argsObj,
            status: 'running',
          };
          emit({ type: 'tool_start', step: runningStep });

          const execRes = await executeWorkspaceTool({
            toolName: call.name,
            args: argsObj,
            modelAlias: deployment.alias,
          });

          const doneStep: AgentToolStep = {
            id: stepId,
            toolName: call.name,
            args: argsObj,
            status: execRes.status,
            durationMs: execRes.durationMs,
            output: execRes.output,
            ...(!execRes.ok ? { error: execRes.output } : {}),
          };
          emit({ type: 'tool_result', step: doneStep });

          history.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: execRes.output,
          });
        }
      }
    } else {
      const ai = getGeminiClient();
      const baseModel = deployment.baseModel as 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite';
      const geminiDecls = toolsActive ? getGeminiWorkspaceToolDeclarations(accessCfg) : [];

      const contents: Content[] = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        }));

      if (contents.length === 0) {
        contents.push({ role: 'user', parts: [{ text: 'Привет!' }] });
      }

      for (let iter = 0; iter < maxIterations; iter++) {
        if (signal.aborted) break;

        const stream = await ai.models.generateContentStream({
          model: baseModel,
          contents,
          config: {
            ...(combinedSystem.trim() ? { systemInstruction: combinedSystem.trim() } : {}),
            ...(geminiDecls.length > 0
              ? { tools: [{ functionDeclarations: geminiDecls }] }
              : {}),
            ...(baseModel === 'gemini-4-hydrogen'
              ? { thinkingConfig: { thinkingLevel: mapThinkingLevel(deployment.thinkingLevel) } }
              : {}),
          },
        });

        const collectedParts: Part[] = [];
        const functionCallsToRun: Array<{
          id?: string;
          name: string;
          args: Record<string, unknown>;
        }> = [];

        for await (const chunk of stream) {
          if (signal.aborted) break;

          const candidateParts = chunk.candidates?.[0]?.content?.parts;
          if (Array.isArray(candidateParts)) {
            for (const part of candidateParts) {
              collectedParts.push(part);
              if (part.functionCall?.name) {
                functionCallsToRun.push({
                  id: part.functionCall.id,
                  name: part.functionCall.name,
                  args:
                    part.functionCall.args && typeof part.functionCall.args === 'object'
                      ? (part.functionCall.args as Record<string, unknown>)
                      : {},
                });
              }
            }
          }

          const deltaText = chunk.text ?? '';
          if (deltaText) {
            if (ttftMs === null) ttftMs = Math.round(performance.now() - startedAt);
            totalGeneratedText += deltaText;
            engine.appendStreamTokens(record, deltaText);
            emit({ type: 'text', delta: deltaText });
          }

          const meta = chunk.usageMetadata;
          if (meta) {
            totalPromptTokens += meta.promptTokenCount ?? 0;
            totalCompletionTokens += meta.candidatesTokenCount ?? 0;
            totalAllTokens += meta.totalTokenCount ?? 0;
          }
        }

        if (functionCallsToRun.length === 0 || !toolsActive) {
          break;
        }

        // Preserve full model turn (including functionCall and thoughtSignature parts)
        contents.push({
          role: 'model',
          parts: collectedParts,
        });

        const responseParts: Part[] = [];
        for (const fc of functionCallsToRun) {
          if (signal.aborted) break;
          const stepId = `step-${Date.now().toString(36)}-${stepsCount++}`;
          const runningStep: AgentToolStep = {
            id: stepId,
            toolName: fc.name,
            args: fc.args,
            status: 'running',
          };
          emit({ type: 'tool_start', step: runningStep });

          const execRes = await executeWorkspaceTool({
            toolName: fc.name,
            args: fc.args,
            modelAlias: deployment.alias,
          });

          const doneStep: AgentToolStep = {
            id: stepId,
            toolName: fc.name,
            args: fc.args,
            status: execRes.status,
            durationMs: execRes.durationMs,
            output: execRes.output,
            ...(!execRes.ok ? { error: execRes.output } : {}),
          };
          emit({ type: 'tool_result', step: doneStep });

          responseParts.push({
            functionResponse: {
              id: fc.id,
              name: fc.name,
              response: {
                ok: execRes.ok,
                output: execRes.output,
              },
            },
          });
        }

        contents.push({
          role: 'user',
          parts: responseParts,
        });
      }
    }

    const totalMs = Math.max(1, Math.round(performance.now() - startedAt));
    const resolvedTtft = ttftMs ?? totalMs;
    const resolvedCompletionTokens =
      totalCompletionTokens || Math.max(1, Math.ceil(totalGeneratedText.length / 4));
    const resolvedPromptTokens =
      totalPromptTokens || Math.max(1, Math.ceil(promptChars / 4));
    const resolvedTotalTokens =
      totalAllTokens || resolvedPromptTokens + resolvedCompletionTokens;
    const tokensPerSec =
      totalMs > 0 ? Number((resolvedCompletionTokens / (totalMs / 1000)).toFixed(1)) : null;

    engine.markRequestCompleted(deployment.id, record, {
      cacheHit: false,
      promptTokens: resolvedPromptTokens,
      completionTokens: resolvedCompletionTokens,
      totalTokens: resolvedTotalTokens,
      ttftMs: resolvedTtft,
      durationMs: totalMs,
    });

    emit({
      type: 'done',
      ttftMs: resolvedTtft,
      totalMs,
      promptTokens: resolvedPromptTokens,
      completionTokens: resolvedCompletionTokens,
      totalTokens: resolvedTotalTokens,
      tokensPerSec,
      stepsCount,
    });
  } catch (err) {
    if (signal.aborted) {
      engine.markRequestError(deployment.id, record, 'Прервано пользователем', performance.now() - startedAt);
      return;
    }
    const mapped = formatGeminiError(err);
    engine.markRequestError(deployment.id, record, mapped.message, performance.now() - startedAt);
    emit({ type: 'error', message: mapped.message });
  } finally {
    engine.releaseSlot(deployment.id);
  }
}
