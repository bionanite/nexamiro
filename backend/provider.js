const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class ProviderError extends Error {
  constructor(message) { super(message); this.name = 'ProviderError'; }
}

function boundedInteger(value, fallback, min, max) {
  if (value === undefined || value === '') return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new Error(`Model request limits must be integers between ${min} and ${max}.`);
  }
  return result;
}

export function createProvider({ env = process.env, fetchImpl = fetch } = {}) {
  const base = (env.MODEL_BASE_URL || '').trim();
  const general = (env.MODEL_GENERAL || '').trim();
  if (Boolean(base) !== Boolean(general)) {
    throw new Error('Set both MODEL_BASE_URL and MODEL_GENERAL, or leave both unset for demo mode.');
  }
  let url;
  if (base) {
    try { url = new URL(base); } catch { throw new Error('MODEL_BASE_URL must be an HTTP or HTTPS URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('MODEL_BASE_URL must be HTTP(S) without credentials, query parameters, or a fragment.');
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  }
  const models = {
    general,
    reasoning: (env.MODEL_REASONING || '').trim() || general,
    coding: (env.MODEL_CODING || '').trim() || general,
  };
  if (Object.values(models).some(model => model.length > 200 || /[\r\n\0]/.test(model))) {
    throw new Error('Model names must be no longer than 200 characters and contain no control characters.');
  }
  const timeout = boundedInteger(env.MODEL_TIMEOUT_MS, 60_000, 100, 180_000);
  const maxTokens = boundedInteger(env.MODEL_MAX_TOKENS, 1800, 64, 8192);
  const apiKey = env.MODEL_API_KEY || '';
  const name = (env.MODEL_PROVIDER_NAME || (url ? 'OpenAI-compatible endpoint' : 'Local demo')).slice(0, 100);

  return {
    configured: Boolean(url),
    info: { name, configured: Boolean(url), baseUrl: url?.toString().replace(/\/$/, '') || '', models },
    async complete({ system, prompt, model, signal }) {
      if (!url) throw new ProviderError('No model endpoint is configured.');
      const deadline = AbortSignal.timeout(timeout);
      const combinedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      try {
        const response = await fetchImpl(new URL('chat/completions', url), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
            temperature: 0.3,
            max_tokens: maxTokens,
            stream: false,
          }),
          signal: combinedSignal,
          redirect: 'error',
        });
        if (!response.ok) {
          // Provider response bodies can contain secrets or internal request details.
          await response.body?.cancel().catch(() => {});
          throw new ProviderError(`Model endpoint returned HTTP ${response.status}. Check the server configuration.`);
        }
        const reader = response.body?.getReader();
        if (!reader) throw new ProviderError('Model endpoint returned an empty response.');
        const chunks = [];
        let bytes = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) {
              await reader.cancel();
              throw new ProviderError('Model response exceeded the supported size.');
            }
            chunks.push(Buffer.from(value));
          }
        } finally { reader.releaseLock(); }
        let result;
        try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new ProviderError('Model endpoint returned invalid JSON.'); }
        if (result.choices?.[0]?.finish_reason === 'length') {
          throw new ProviderError('Model output reached its token limit before finishing. Try a smaller task or increase MODEL_MAX_TOKENS.');
        }
        const text = result.choices?.[0]?.message?.content;
        if (typeof text !== 'string' || !text.trim()) throw new ProviderError('Model endpoint returned no text answer.');
        if (text.length > 20_000) throw new ProviderError('Model answer exceeded the supported size. Try a smaller task.');
        const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
        return {
          text: text.trim(),
          usage: { inputTokens: tokenCount(result.usage?.prompt_tokens), outputTokens: tokenCount(result.usage?.completion_tokens) },
        };
      } catch (error) {
        if (signal?.aborted) throw new DOMException('Task cancelled.', 'AbortError');
        if (deadline.aborted) throw new ProviderError('Model request timed out. Try a smaller task or check your endpoint.');
        if (error instanceof ProviderError) throw error;
        throw new ProviderError('Cannot reach the model endpoint. Check its URL, credentials, and availability.');
      }
    },
  };
}
