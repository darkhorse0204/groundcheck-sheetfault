'use strict';
/**
 * One tiny request per hosted model through the evaluation backend: does the key reach it, what does the API
 * report as the model version, and does a formula request come back well-formed?
 *   GEMINI_API_KEY=... node probe_models.js gemini-3.1-flash-lite gemini-3.5-flash-lite gemma-4-31b-it
 */
const { makeBackend } = require('./lib/llm');

const payload = {
  system_instruction: { parts: { text: 'You are an expert Google Sheets formula engineer. Output ONLY the raw formula starting with =.' } },
  contents: [{ role: 'user', parts: [{ text: 'Sum of column B from row 2 to row 80.' }] }],
  generationConfig: { temperature: 0.2 }
};

for (const m of process.argv.slice(2)) {
  const spec = /^(gemini|gemma|openai):/.test(m) ? m : 'gemini:' + m;
  const b = makeBackend(spec.replace(/^gemma:/, 'gemini:'));
  try {
    const r = b.fetchStub('x', { payload: JSON.stringify(payload) });
    const text = JSON.parse(r.getContentText()).candidates[0].content.parts[0].text;
    console.log(`${m}: ok | versions ${JSON.stringify(b.state.modelVersions)} | ${b.state.ms} ms | ${JSON.stringify(text.trim().slice(0, 80))}`);
  } catch (e) {
    console.log(`${m}: FAILED ${String(e.message).slice(0, 160)}`);
  }
}
