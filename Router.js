/**
 * Router.js — Intent Classification via Gemini Function Calling
 *
 * In V1, the user had to manually click a mode button (Gen/Fix/Explain/Fetch/Push).
 * Now, when "Auto" mode is selected, this Router Agent classifies intent semantically
 * using Gemini's function calling. It's basically a smart switch statement powered by an LLM.
 *
 * Uses Flash (not Pro) because this is a classification task, not a reasoning task.
 * No need to burn Pro-tier tokens just to figure out "is this a debug request or a generate request."
 */

// These are the "tools" we declare to Gemini. By setting mode: 'ANY' in the call config,
// we force Gemini to always return a function call — never free text.
// The descriptions matter a LOT here. They're what Gemini uses to disambiguate.
// e.g., "sum my revenue" should match generate_formula, not explain_formula.
var ROUTER_TOOLS_ = [{
  functionDeclarations: [
    {
      name: 'generate_formula',
      description: 'Generate a new spreadsheet formula from a natural language description. Use when the user wants to create a formula, calculate something, or automate a computation.',
      parameters: {
        type: 'OBJECT',
        properties: {
          task_description: {
            type: 'STRING',
            description: 'The clear description of what formula the user needs'
          }
        },
        required: ['task_description']
      }
    },
    {
      name: 'debug_formula',
      description: 'Fix or debug a broken spreadsheet formula. Use when the user provides a formula that has errors, is not working, or produces wrong results.',
      parameters: {
        type: 'OBJECT',
        properties: {
          broken_formula: {
            type: 'STRING',
            description: 'The broken formula to fix'
          },
          error_description: {
            type: 'STRING',
            description: 'Optional description of what error the user is seeing'
          }
        },
        required: ['broken_formula']
      }
    },
    {
      name: 'explain_formula',
      description: 'Explain how a spreadsheet formula works step-by-step. Use when the user wants to understand a formula.',
      parameters: {
        type: 'OBJECT',
        properties: {
          formula: {
            type: 'STRING',
            description: 'The formula to explain'
          }
        },
        required: ['formula']
      }
    },
    {
      name: 'fetch_data',
      description: 'Fetch data from an external public API and insert it into the spreadsheet. Use when the user wants to pull in external data like prices, weather, users, etc.',
      parameters: {
        type: 'OBJECT',
        properties: {
          data_request: {
            type: 'STRING',
            description: 'Description of what data to fetch'
          }
        },
        required: ['data_request']
      }
    },
    {
      name: 'push_data',
      description: 'Send spreadsheet row data to an external webhook or API endpoint. Use when the user wants to push/sync/send data to an external service.',
      parameters: {
        type: 'OBJECT',
        properties: {
          target_description: {
            type: 'STRING',
            description: 'Description including the target webhook URL'
          }
        },
        required: ['target_description']
      }
    }
  ]
}];

// The actual routing call. Sends the user's prompt + spreadsheet context to Gemini Flash
// and gets back: { intent: 'generate_formula', params: { task_description: '...' } }
//
// Returns null on failure — the caller (handleRequest) falls back to 'generate_formula'
// because it's the safest default. If you can't figure out what someone wants, formula gen
// is the most forgiving mode.
function classifyIntent_(prompt, contextString) {
  var systemPrompt = 'You are an intent classifier for a Google Sheets AI assistant. ' +
    'Based on the user\'s message and the spreadsheet context, determine which action to take. ' +
    'Call the appropriate function.\n\n' + contextString;

  try {
    var response = callGemini_({
      model: CONFIG.MODELS.FAST,
      systemInstruction: systemPrompt,
      contents: [{ parts: [{ text: prompt }] }],
      tools: ROUTER_TOOLS_,
      forceFunctionCall: true,
      temperature: 0.1,   // Near-zero for consistent, deterministic classification
      agent: 'Router'
    });

    var fnCall = extractFunctionCall_(response);
    if (fnCall) {
      logInfo_('Router', 'Classified intent', { intent: fnCall.name, params: fnCall.args });
      return { intent: fnCall.name, params: fnCall.args };
    }

    // Shouldn't happen with forceFunctionCall: true, but just in case
    logWarn_('Router', 'No function call returned, defaulting to generate');
    return { intent: 'generate_formula', params: { task_description: prompt } };
  } catch (e) {
    logError_('Router', 'Classification failed: ' + e.message);
    return null; // Graceful degradation — caller uses manual mode or defaults
  }
}
