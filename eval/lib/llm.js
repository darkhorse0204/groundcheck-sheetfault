'use strict';
/**
 * LLM backends for the end-to-end study, exposed as a drop-in replacement for
 * Google Apps Script's UrlFetchApp.fetch: the production code (Api.js's
 * callGemini_) builds a Gemini-format request, this stub translates it to the
 * chosen backend and translates the answer back to Gemini's response format.
 * Nothing in the add-on's source is modified for the evaluation.
 *
 * Backends:
 *   ollama:<model>   a local model served by Ollama (synchronous HTTP via curl)
 *   gemini:<model>   Google's Gemini API (needs GEMINI_API_KEY in the environment); also serves Gemma
 *   openai:<model>   OpenAI Chat Completions API (needs OPENAI_API_KEY)
 *   mock             deterministic fake used ONLY to test the harness plumbing
 *
 * Every hosted response's self-reported model version is collected in state.modelVersions, and the
 * driver stores it with each task, so the exact model that answered is part of the result file.
 * (The openai backend was written for readers who have a key; it was not run for the paper.)
 */
const { spawnSync } = require('child_process');

function curlJson(url, body, headers, timeoutSec) {
  const args = ['-s', '-m', String(timeoutSec || 900), '-X', 'POST', url, '--data-binary', '@-'];
  (headers || ['Content-Type: application/json']).forEach((h) => { args.push('-H', h); });
  const r = spawnSync('curl', args, { input: JSON.stringify(body), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('curl failed: ' + (r.stderr || r.status));
  return JSON.parse(r.stdout);
}

function geminiToMessages(payload) {
  const msgs = [];
  const sys = payload.system_instruction && payload.system_instruction.parts && payload.system_instruction.parts.text;
  if (sys) msgs.push({ role: 'system', content: sys });
  (payload.contents || []).forEach((c) => {
    const text = (c.parts || []).map((p) => p.text || '').join('');
    msgs.push({ role: c.role === 'model' ? 'assistant' : 'user', content: text });
  });
  return msgs;
}

function makeBackend(spec, opts) {
  opts = opts || {};
  const state = { calls: 0, promptTokens: 0, completionTokens: 0, ms: 0, seed: 1, bucket: 'unassigned', buckets: {}, modelVersions: {} };
  const noteVersion = (v) => { if (v) state.modelVersions[v] = (state.modelVersions[v] || 0) + 1; };

  function account(promptTokens, completionTokens, ms) {
    state.calls++; state.promptTokens += promptTokens; state.completionTokens += completionTokens; state.ms += ms;
    const b = state.buckets[state.bucket] = state.buckets[state.bucket] || { calls: 0, promptTokens: 0, completionTokens: 0, ms: 0 };
    b.calls++; b.promptTokens += promptTokens; b.completionTokens += completionTokens; b.ms += ms;
  }

  let complete;
  if (spec.startsWith('ollama:')) {
    const model = spec.slice(7);
    complete = (payload) => {
      const temperature = payload.generationConfig && payload.generationConfig.temperature !== undefined ? payload.generationConfig.temperature : 0.2;
      const t0 = Date.now();
      const res = curlJson('http://localhost:11434/api/chat', {
        model, messages: geminiToMessages(payload), stream: false,
        options: { temperature, seed: state.seed, num_predict: opts.numPredict || 200, num_ctx: opts.numCtx || 4096 },
        keep_alive: '30m'
      });
      if (res.error) throw new Error('ollama: ' + res.error);
      account(res.prompt_eval_count || 0, res.eval_count || 0, Date.now() - t0);
      return { text: res.message.content, promptTokens: res.prompt_eval_count || 0, completionTokens: res.eval_count || 0 };
    };
  } else if (spec.startsWith('gemini:')) {
    const model = spec.slice(7);
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY is not set');
    // The 2.5 models "think" and thinking tokens count against maxOutputTokens: disable it on Flash,
    // use the smallest budget Pro allows, and leave room for the (short) formula.
    // Gemini 3.x replaced the token budget with a coarse level; Pro cannot disable thinking.
    // Gemma models (open weights, served by the same API) do not accept a system
    // instruction: the instruction is folded into the first user turn instead.
    const isGemma = /^gemma/.test(model);
    // (Gemma 4 prints its reasoning into the reply unless its thinking level is minimal.)
    const thinkingConfig = isGemma ? { thinkingLevel: 'minimal' } : /gemini-3/.test(model) ? { thinkingLevel: 'low' } : { thinkingBudget: /pro/.test(model) ? 128 : 0 };
    const sleepSec = (n) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n * 1000);
    complete = (payload) => {
      const t0 = Date.now();
      const body = Object.assign({}, payload);
      if (isGemma) {
        const sys = payload.system_instruction && payload.system_instruction.parts && payload.system_instruction.parts.text;
        delete body.system_instruction;
        body.contents = (payload.contents || []).map((c) => ({ role: c.role, parts: (c.parts || []).map((p) => ({ text: p.text || '' })) }));
        if (sys && body.contents.length) body.contents[0].parts[0].text = sys + '\n\n' + body.contents[0].parts[0].text;
      }
      body.generationConfig = Object.assign({}, payload.generationConfig, { seed: state.seed & 0x7fffffff, maxOutputTokens: opts.numPredict || 1024 });
      if (thinkingConfig) body.generationConfig.thinkingConfig = thinkingConfig;
      let res;
      for (let attempt = 0; attempt < 8; attempt++) {
        // the key travels in a header, never in the URL or on disk
        try {
          res = curlJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, body, ['Content-Type: application/json', 'x-goog-api-key: ' + key], 180);
        } catch (e) { // network hiccup or an unparsable reply: wait and retry
          if (attempt === 7) throw e;
          sleepSec(Math.min(60, 6 * (attempt + 1)));
          continue;
        }
        // a per-day quota will not clear by waiting: stop the run (it is resumable) instead of recording errors
        if (res.error && res.error.code === 429 && /PerDay/.test(JSON.stringify(res.error))) {
          process.stderr.write('gemini: daily quota exhausted, stopping (rerun with --resume tomorrow)\n');
          process.exit(3);
        }
        if (res.error && (res.error.code === 429 || res.error.code >= 500)) { sleepSec(Math.min(60, 6 * (attempt + 1))); continue; }
        break;
      }
      if (res.error) throw new Error('gemini: ' + String(res.error.message).slice(0, 200));
      noteVersion(res.modelVersion || 'unreported');
      const u = res.usageMetadata || {};
      const cand = (res.candidates || [{}])[0] || {};
      const text = ((cand.content || { parts: [] }).parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
      if (!text && cand.finishReason && cand.finishReason !== 'STOP') throw new Error('gemini: empty reply (' + cand.finishReason + ')');
      account(u.promptTokenCount || 0, (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), Date.now() - t0);
      return { text, promptTokens: u.promptTokenCount || 0, completionTokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) };
    };
  } else if (spec.startsWith('openai:')) {
    const model = spec.slice(7);
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY is not set');
    complete = (payload) => {
      const t0 = Date.now();
      const temperature = payload.generationConfig && payload.generationConfig.temperature !== undefined ? payload.generationConfig.temperature : 0.2;
      const body = { model, messages: geminiToMessages(payload), max_completion_tokens: opts.numPredict || 1024, seed: state.seed & 0x7fffffff };
      if (!opts.noTemperature) body.temperature = temperature;
      const res = curlJson('https://api.openai.com/v1/chat/completions', body, ['Content-Type: application/json', 'Authorization: Bearer ' + key]);
      if (res.error) throw new Error('openai: ' + String(res.error.message).slice(0, 200));
      noteVersion(res.model);
      const u = res.usage || {};
      account(u.prompt_tokens || 0, u.completion_tokens || 0, Date.now() - t0);
      return { text: (res.choices[0].message.content || ''), promptTokens: u.prompt_tokens || 0, completionTokens: u.completion_tokens || 0 };
    };
  } else if (spec === 'mock') {
    complete = (payload) => {
      const text = opts.mockReply ? opts.mockReply(payload, state) : '=SUM(A1)';
      account(100, 20, 1);
      return { text, promptTokens: 100, completionTokens: 20 };
    };
  } else {
    throw new Error('unknown backend ' + spec);
  }

  /** The UrlFetchApp.fetch stub installed into the GAS sandbox. */
  function fetchStub(url, fetchOptions) {
    const payload = JSON.parse(fetchOptions.payload);
    const out = complete(payload);
    const body = {
      candidates: [{ content: { parts: [{ text: out.text }] } }],
      usageMetadata: { promptTokenCount: out.promptTokens, candidatesTokenCount: out.completionTokens }
    };
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify(body) };
  }

  return { fetchStub, state, setSeed: (s) => { state.seed = s >>> 0; }, setBucket: (b) => { state.bucket = b; } };
}

module.exports = { makeBackend };
