/**
 * MemoryManager.js — Five-Layer Memory System
 *
 * Designed to mirror how Cursor handles project and session state:
 *   - Memory is ambient (agents read it automatically, not on request)
 *   - Memory is contextually scoped (session vs. workbook vs. user-global)
 *   - Memory improves over time (preferences are learned, not just set)
 *   - Memory degrades gracefully (TTL expiry never crashes, just resets)
 *
 * ── Storage Backend Assignments ─────────────────────────────────────────────
 *
 *   CacheService.getUserCache()        — hot, temporary, TTL-bounded
 *     └── Conversation Memory          TTL: 2 hours (session window)
 *     └── Task Memory                  TTL: 4 hours (long tasks)
 *
 *   PropertiesService.getUserProperties()  — warm, persistent, no TTL
 *     └── User Preference Memory       never expires
 *     └── Recent Operations            rolling window of 25 ops
 *     └── Conversation Summaries       written at session end, read at start
 *
 *   PropertiesService.getDocumentProperties()  — persistent, per-spreadsheet
 *     └── Workbook Memory              never expires, scoped to this file
 *
 * ── Storage Budget ──────────────────────────────────────────────────────────
 *
 *   PropertiesService.getUserProperties()  total: 500 KB
 *     User prefs:            ~  2 KB
 *     Recent ops (25):       ~  8 KB
 *     Conv summaries (10):   ~ 30 KB   (3 KB each × up to 10 workbooks)
 *     ─────────────────────────────
 *     Ceiling used:          ~ 40 KB   (comfortable — 460 KB headroom)
 *
 *   PropertiesService.getDocumentProperties()  total: 500 KB per spreadsheet
 *     Workbook memory:       ~ 15 KB
 *     Learned patterns:      ~  5 KB
 *     ─────────────────────────────
 *     Total per workbook:    ~ 20 KB   (comfortable)
 *
 *   CacheService  (per key limit: 100 KB)
 *     Conversation (20 turns):  ~  25 KB   (well under limit)
 *     Task state:               ~   5 KB
 *
 * ── Memory Lifecycle ────────────────────────────────────────────────────────
 *
 *   1. CONVERSATION MEMORY
 *      Created:  First handleRequest() of a session
 *      Updated:  After every request/response pair
 *      Expired:  CacheService TTL at 2 hours of inactivity
 *      Archived: On explicit clearChatMemory() → summary written to UserProperties
 *      Format:   JSON array of ConversationTurn objects
 *
 *   2. WORKBOOK MEMORY
 *      Created:  First time a spreadsheet is used with the tool
 *      Updated:  After schema change detected (fingerprint mismatch)
 *                After each session (lastVisited, lastActiveSheet)
 *                After a learned pattern is confirmed (user accepted output)
 *      Expires:  Never. Survives indefinitely in DocumentProperties.
 *      Pruned:   learnedPatterns capped at 50. Oldest evicted first.
 *      Format:   Single JSON blob per spreadsheet
 *
 *   3. USER PREFERENCE MEMORY
 *      Created:  First time the tool is used by this Google account
 *      Updated:  After each session (sessionCount, totalRequests)
 *                After user-accepted formula (observe function usage)
 *                After user-rejected formula (record rejection signal)
 *      Expires:  Never.
 *      Format:   Single JSON blob in UserProperties
 *
 *   4. TASK MEMORY
 *      Created:  When Planner emits a multi-step plan
 *      Updated:  After each plan step completes
 *      Expired:  CacheService TTL at 4 hours OR on task.complete()
 *      NOT persisted: task state is ephemeral by design
 *      Format:   JSON object with steps array and accumulated results
 *
 *   5. RECENT OPERATIONS
 *      Created:  On first write tool call
 *      Updated:  After every destructive tool call (insert, write, chart, pivot)
 *      Expires:  Never. Rolling window — oldest op evicted when > 25 entries
 *      Format:   JSON array of OperationRecord objects in UserProperties
 *
 *   6. TASK HISTORY
 *      Created:  When a plan first completes or fails (Planner.js's executePlanStep)
 *      Updated:  Every subsequent plan completion/failure
 *      Expires:  Never. Rolling window — oldest entry evicted when > 30 entries
 *      Format:   JSON array of { taskId, intent, prompt, status, stepCount,
 *                stepTools, completedAt } in UserProperties
 *      Purpose:  This is what makes memory automatically influence future
 *                planning — Planner.js's generatePlan() calls
 *                buildContextString(intent) on every call, which folds in
 *                getContextHint(intent): past success rate + the most common
 *                successful step pattern for that exact intent.
 *
 * ── Public API ───────────────────────────────────────────────────────────────
 *
 *   All six namespaces are exposed on the global MEMORY object:
 *
 *   MEMORY.conversation.get()             → ConversationMemory | null
 *   MEMORY.conversation.append(turn)      → void
 *   MEMORY.conversation.getHistory()      → ConversationTurn[]
 *   MEMORY.conversation.compress()        → void  (LLM-based summarization)
 *   MEMORY.conversation.clear()           → void  (archives then wipes)
 *   MEMORY.conversation.getSummary()      → string  (for context injection)
 *
 *   MEMORY.workbook.get()                 → WorkbookMemory | null
 *   MEMORY.workbook.touch()               → void  (update lastVisited + cursor)
 *   MEMORY.workbook.updateSchema(hash)    → void
 *   MEMORY.workbook.annotate(range, note) → void
 *   MEMORY.workbook.learn(pattern)        → void
 *   MEMORY.workbook.getContextHint()      → string  (for prompt injection)
 *
 *   MEMORY.prefs.get()                    → UserPreferences
 *   MEMORY.prefs.update(patch)            → void
 *   MEMORY.prefs.observeAccepted(formula) → void  (learns from accepted output)
 *   MEMORY.prefs.observeRejected(reason)  → void  (learns from rejection)
 *   MEMORY.prefs.getStyleHint()           → string  (for prompt injection)
 *
 *   MEMORY.task.get()                     → TaskMemory | null
 *   MEMORY.task.set(plan)                 → void
 *   MEMORY.task.stepComplete(id, result)  → void
 *   MEMORY.task.fail(id, reason)          → void
 *   MEMORY.task.complete()                → void
 *   MEMORY.task.isActive()                → boolean
 *
 *   MEMORY.ops.record(op)                 → void
 *   MEMORY.ops.getRecent(n)               → OperationRecord[]
 *   MEMORY.ops.getLastUndoable()          → OperationRecord | null
 *   MEMORY.ops.markUndone(opId)           → void
 *
 *   MEMORY.taskHistory.record(entry)      → taskId (string)
 *   MEMORY.taskHistory.getRecent(n)       → TaskHistoryEntry[]
 *   MEMORY.taskHistory.getSimilar(intent) → TaskHistoryEntry[]  (same intent, most recent first)
 *   MEMORY.taskHistory.getContextHint(intent) → string  (success rate + step pattern, for prompt injection)
 */

// ─────────────────────────────────────────────────────────────────────────────
// STORAGE KEYS — single source of truth. Never hardcode these elsewhere.
// ─────────────────────────────────────────────────────────────────────────────

var MEM_KEYS_ = {
  // CacheService (UserCache)
  CONVERSATION:      'MEM_CONV',
  TASK:              'MEM_TASK',

  // PropertiesService (UserProperties)
  USER_PREFS:        'MEM_PREFS',
  RECENT_OPS:        'MEM_OPS',
  CONV_SUMMARY_PFX:  'MEM_SUM_',   // + spreadsheetId suffix
  TASK_HISTORY:      'MEM_TASK_HISTORY',

  // PropertiesService (DocumentProperties) — per spreadsheet
  WORKBOOK:          'MEM_WORKBOOK'
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — CONVERSATION MEMORY
// Two-tier: CacheService (live turns) + UserProperties (archived summary)
// ─────────────────────────────────────────────────────────────────────────────

var conversationMemory_ = {

  /**
   * Get the full in-session conversation memory object.
   * Returns null on cache miss (session expired or not started).
   *
   * Why CacheService here and not PropertiesService?
   * Conversation turns can be large (~25 KB for 20 turns). PropertiesService
   * has a 9 KB per-key limit. CacheService allows up to 100 KB per key.
   * The 2-hour TTL also matches the natural "working session" window — if a
   * user comes back 3 hours later, starting fresh with the archived summary
   * is almost always better than replaying a stale conversation.
   */
  get: function() {
    try {
      var raw = CacheService.getUserCache().get(MEM_KEYS_.CONVERSATION);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      logWarn_('Memory', 'Conversation cache read failed: ' + e.message);
      return null;
    }
  },

  /**
   * Initialize a new conversation session.
   * Called once per user session (not per request).
   * Loads the archived summary from the previous session as the first synthetic
   * "context" turn — this is the Cursor equivalent of re-opening a project and
   * having the AI remember what you were working on.
   */
  init: function(spreadsheetId) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var existing = this.get();
    if (existing && existing.spreadsheetId === spreadsheetId) {
      // Same spreadsheet, session still warm — don't overwrite
      return existing;
    }

    // Load previous session summary (if any) to seed continuity
    var summary = this._loadSummary_(spreadsheetId);

    var session = {
      sessionId: 'sess_' + new Date().getTime(),
      spreadsheetId: spreadsheetId,
      sheetName: ss.getActiveSheet().getName(),
      startedAt: new Date().toISOString(),
      turns: [],
      totalTokens: 0,
      // Inject last session's summary as the first synthetic turn so the LLM
      // has continuity without receiving the entire previous conversation verbatim.
      priorContext: summary || null
    };

    this._save_(session);
    logInfo_('Memory', 'Conversation session initialized', { sessionId: session.sessionId });
    return session;
  },

  /**
   * Append a turn to the conversation.
   * A "turn" is one message from either the user, the model, or a tool.
   *
   * Why we track tokenCount per turn:
   * The compress() function uses this to decide which turns to summarize.
   * We don't re-count tokens; we use the response's usageMetadata if available,
   * falling back to a rough estimate (4 chars ≈ 1 token).
   */
  append: function(turn) {
    var session = this.get();
    if (!session) {
      logWarn_('Memory', 'append() called on expired session — re-initializing');
      session = this.init(SpreadsheetApp.getActiveSpreadsheet().getId());
    }

    var enrichedTurn = {
      turnId: 'turn_' + String(session.turns.length + 1).padStart(3, '0'),
      role: turn.role,           // 'user' | 'model' | 'tool'
      content: turn.content,
      toolName: turn.toolName || null,
      timestamp: new Date().toISOString(),
      tokenCount: turn.tokenCount || Math.ceil((turn.content || '').length / 4)
    };

    session.turns.push(enrichedTurn);
    session.totalTokens += enrichedTurn.tokenCount;

    // Compress if history is getting large.
    // Threshold: 15 turns or 20,000 estimated tokens (CacheService limit is 100KB,
    // but we compress well before that to keep prompts manageable).
    if (session.turns.length > CONFIG.MEMORY.MAX_TURNS ||
        session.totalTokens > CONFIG.MEMORY.MAX_TOKENS_BEFORE_COMPRESS) {
      session = this._compressInPlace_(session);
    }

    this._save_(session);
  },

  /**
   * Get the conversation turns formatted for Gemini's `contents` array.
   * This is what agents feed into callGemini_() as their chat history.
   * Prepends the priorContext summary if present.
   */
  getHistory: function() {
    var session = this.get();
    if (!session) return [];

    var history = [];

    // Inject prior session context as a synthetic opening exchange.
    // The model sees this as: "User opened the spreadsheet. AI recalls what happened last time."
    // This is the Cursor "project rules / previous chat" pattern.
    if (session.priorContext) {
      history.push({
        role: 'user',
        parts: [{ text: '[Session context from previous session]\n' + session.priorContext }]
      });
      history.push({
        role: 'model',
        parts: [{ text: 'Understood. I remember your previous session. Continuing from there.' }]
      });
    }

    // Append the actual turns (already in Gemini content format)
    session.turns.forEach(function(t) {
      if (t.role === 'tool') return; // Tool results are already embedded in model turns
      history.push({
        role: t.role,
        parts: [{ text: t.content }]
      });
    });

    return history;
  },

  /**
   * Returns a compact summary of the session for injection into system prompts.
   * Format: "In this session: [list of what was done]. Last formula: =SUMIF(...)"
   */
  getSummary: function() {
    var session = this.get();
    if (!session || session.turns.length === 0) return '';

    var userTurns = session.turns.filter(function(t) { return t.role === 'user'; });
    if (userTurns.length === 0) return '';

    var lines = ['Current session context:'];
    lines.push('  Session started: ' + session.startedAt);
    lines.push('  Requests so far: ' + userTurns.length);

    // Include prior context snippet if present
    if (session.priorContext) {
      lines.push('  Prior session note: ' + session.priorContext.substring(0, 200));
    }

    return lines.join('\n');
  },

  /**
   * Wipe the live session and archive a summary to UserProperties.
   * This is the "clear memory" action. The summary persists so the NEXT session
   * can pick up where the user left off — just like Cursor's "New Chat" that still
   * remembers your project context via .cursorrules.
   */
  clear: function() {
    var session = this.get();
    if (session) {
      // Archive a summary before clearing (don't just throw it away)
      this._archiveSummary_(session);
    }
    CacheService.getUserCache().remove(MEM_KEYS_.CONVERSATION);
    logInfo_('Memory', 'Conversation memory cleared and archived');
  },

  // ── Private helpers ────────────────────────────────────────────────────────

  _save_: function(session) {
    try {
      var serialized = JSON.stringify(session);
      // CacheService has a 100KB limit per key. If we're approaching it, compress.
      if (serialized.length > 90000) {
        session = this._compressInPlace_(session);
        serialized = JSON.stringify(session);
      }
      CacheService.getUserCache().put(
        MEM_KEYS_.CONVERSATION,
        serialized,
        CONFIG.MEMORY.CONVERSATION_TTL_SECONDS
      );
    } catch (e) {
      // Non-fatal. Worst case: next request starts a fresh session.
      logError_('Memory', 'Conversation save failed: ' + e.message);
    }
  },

  /**
   * Compress in-place: keep the last KEEP_RECENT_TURNS verbatim, replace
   * older turns with a plain-text summary.
   *
   * Why a fixed-length rolling window rather than LLM summarization?
   * LLM summarization costs a Flash call + 200–500ms latency on every message
   * once history is long. A fixed window is free, instant, and sufficient for
   * most sessions. LLM summarization is reserved for session archiving (the
   * _archiveSummary_ path), where the latency is acceptable.
   */
  _compressInPlace_: function(session) {
    var keepCount = CONFIG.MEMORY.KEEP_RECENT_TURNS;
    if (session.turns.length <= keepCount) return session;

    var old = session.turns.slice(0, session.turns.length - keepCount);
    var kept = session.turns.slice(session.turns.length - keepCount);

    // Build a plain-text digest of the dropped turns
    var digest = old.map(function(t) {
      return '[' + t.role + '] ' + (t.content || '').substring(0, 100);
    }).join('\n');

    // Replace the dropped turns with one synthetic "context" turn
    var contextTurn = {
      turnId: 'compressed',
      role: 'user',
      content: '[Earlier in this session (compressed)]\n' + digest,
      timestamp: old[0].timestamp,
      tokenCount: Math.ceil(digest.length / 4),
      compressed: true
    };

    session.turns = [contextTurn].concat(kept);
    session.totalTokens = session.turns.reduce(function(sum, t) {
      return sum + t.tokenCount;
    }, 0);

    logInfo_('Memory', 'Conversation compressed', {
      droppedTurns: old.length,
      keptTurns: kept.length
    });
    return session;
  },

  /**
   * Archive a plain-text summary of the session to UserProperties.
   * Stored per-spreadsheet so that when the user returns to THIS spreadsheet,
   * the prior session context is loaded automatically.
   */
  _archiveSummary_: function(session) {
    if (!session || session.turns.length === 0) return;

    var userTurns = session.turns.filter(function(t) {
      return t.role === 'user' && !t.compressed;
    });

    var summary = 'Previous session (' + session.startedAt.substring(0, 10) + '): ';
    summary += userTurns.slice(-5).map(function(t) {
      return t.content.substring(0, 80);
    }).join(' | ');

    try {
      var key = MEM_KEYS_.CONV_SUMMARY_PFX + (session.spreadsheetId || 'global');
      // Limit summary to 3KB to preserve UserProperties budget
      PropertiesService.getUserProperties().setProperty(
        key,
        summary.substring(0, 3000)
      );
    } catch (e) {
      logWarn_('Memory', 'Summary archive failed: ' + e.message);
    }
  },

  _loadSummary_: function(spreadsheetId) {
    try {
      var key = MEM_KEYS_.CONV_SUMMARY_PFX + (spreadsheetId || 'global');
      return PropertiesService.getUserProperties().getProperty(key);
    } catch (e) {
      return null;
    }
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — WORKBOOK MEMORY
// DocumentProperties: scoped to the bound spreadsheet, never expires.
// ─────────────────────────────────────────────────────────────────────────────

var workbookMemory_ = {

  /**
   * Get the workbook memory for the current spreadsheet.
   * DocumentProperties automatically scopes to the active spreadsheet —
   * no spreadsheet ID needed in the key.
   *
   * Why DocumentProperties and not UserProperties?
   * This data belongs to the spreadsheet, not the user. If two users share
   * access to the same spreadsheet, they should share learned patterns.
   * DocumentProperties is the only GAS store that provides this scope.
   */
  get: function() {
    try {
      var raw = PropertiesService.getDocumentProperties().getProperty(MEM_KEYS_.WORKBOOK);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      logWarn_('Memory', 'Workbook memory read failed: ' + e.message);
      return null;
    }
  },

  /**
   * Initialize workbook memory on first use of this spreadsheet.
   * Records the schema hash, title, and initial structure.
   */
  init: function(spreadsheetId, title, schemaHash) {
    var wb = {
      spreadsheetId: spreadsheetId,
      title: title,
      createdAt: new Date().toISOString(),
      lastVisited: new Date().toISOString(),
      schemaHash: schemaHash || '',
      lastActiveSheet: '',
      lastActiveCell: '',

      /**
       * Learned formula patterns: { pattern, count, lastUsed, example }
       * Auto-populated when the user accepts a formula output.
       * The LLM receives the top 5 patterns as few-shot context, biasing
       * it toward formulas that have worked for THIS spreadsheet before.
       * This is the closest GAS equivalent of Cursor's codebase-wide indexing.
       */
      learnedPatterns: [],

      /**
       * User annotations: { range → note }
       * Set via MEMORY.workbook.annotate(). These are injected into the
       * context as hard constraints:
       *   "Sheet2!A:A → 'Raw data — never write to this column'"
       * The LLM must respect these annotations. Unlike learned patterns
       * (which are soft suggestions), annotations are treated as rules.
       */
      annotations: {},

      /**
       * Column type overrides: { "SheetName!ColLetter" → type }
       * Set when the user explicitly corrects a type inference mistake.
       * Overrides SpreadsheetEngine's statistical inference for this column.
       */
      columnTypeOverrides: {}
    };

    this._save_(wb);
    return wb;
  },

  /**
   * Update the lastVisited timestamp and active cursor position.
   * Called at the start of every handleRequest(). Cheap — just a timestamp update.
   */
  touch: function(sheetName, cellRef) {
    var wb = this.get();
    if (!wb) return;

    wb.lastVisited = new Date().toISOString();
    if (sheetName) wb.lastActiveSheet = sheetName;
    if (cellRef) wb.lastActiveCell = cellRef;

    this._save_(wb);
  },

  /**
   * Update the schema hash when the workbook structure changes.
   * The SpreadsheetEngine computes a hash of sheet dimensions + header row.
   * If the hash differs from what's stored here, a full re-parse is triggered.
   */
  updateSchema: function(newHash) {
    var wb = this.get();
    if (!wb) return;
    if (wb.schemaHash === newHash) return; // No change — skip the write

    wb.schemaHash = newHash;
    wb.schemaUpdatedAt = new Date().toISOString();
    this._save_(wb);
    logInfo_('Memory', 'Workbook schema hash updated');
  },

  /**
   * Add a user annotation for a range.
   * Used like: MEMORY.workbook.annotate('Sheet2!A:A', 'Raw data — read only');
   * These appear in every context block for that sheet, as a hard constraint.
   */
  annotate: function(rangeRef, note) {
    var wb = this.get();
    if (!wb) return;

    if (note === null || note === '') {
      delete wb.annotations[rangeRef];
    } else {
      wb.annotations[rangeRef] = {
        note: note.substring(0, 200), // Limit annotation length
        setAt: new Date().toISOString()
      };
    }

    this._save_(wb);
    logInfo_('Memory', 'Workbook annotation set', { range: rangeRef });
  },

  /**
   * Record a formula pattern that worked for this workbook.
   * Called by Agents.js when the user accepts a generated formula.
   *
   * A "pattern" is a human-readable description + the formula template.
   * Example: { description: "SUMIF on Region column", formula: "=SUMIF(B:B,criteria,C:C)" }
   *
   * The top 5 patterns are injected into the Formula Agent's system prompt
   * as workbook-specific few-shot examples — exactly how Cursor uses
   * previously-accepted code suggestions to inform future suggestions.
   */
  learn: function(description, formula) {
    var wb = this.get();
    if (!wb) return;

    // Check if this pattern already exists (dedup by formula signature)
    var existing = wb.learnedPatterns.filter(function(p) {
      return p.formula === formula;
    });

    if (existing.length > 0) {
      // Increment usage count instead of adding a duplicate
      existing[0].count = (existing[0].count || 1) + 1;
      existing[0].lastUsed = new Date().toISOString();
    } else {
      wb.learnedPatterns.push({
        description: description.substring(0, 100),
        formula: formula.substring(0, 500),
        count: 1,
        learnedAt: new Date().toISOString(),
        lastUsed: new Date().toISOString()
      });
    }

    // Cap at 50 patterns. Evict least-recently-used when over limit.
    if (wb.learnedPatterns.length > 50) {
      wb.learnedPatterns.sort(function(a, b) {
        return new Date(b.lastUsed) - new Date(a.lastUsed);
      });
      wb.learnedPatterns = wb.learnedPatterns.slice(0, 50);
    }

    this._save_(wb);
    logInfo_('Memory', 'Workbook pattern learned', { description: description });
  },

  /**
   * Returns a string to inject into system prompts containing workbook-specific
   * context: annotations (constraints) and top patterns (few-shot examples).
   * Returns '' if nothing relevant to include.
   */
  getContextHint: function() {
    var wb = this.get();
    if (!wb) return '';

    var lines = [];

    // Annotations — treated as hard constraints in prompts
    var annotationKeys = Object.keys(wb.annotations || {});
    if (annotationKeys.length > 0) {
      lines.push('WORKBOOK CONSTRAINTS (must respect):');
      annotationKeys.forEach(function(ref) {
        lines.push('  ' + ref + ': ' + wb.annotations[ref].note);
      });
    }

    // Top 5 patterns — treated as soft few-shot examples
    var patterns = (wb.learnedPatterns || [])
      .slice()
      .sort(function(a, b) { return (b.count || 1) - (a.count || 1); })
      .slice(0, 5);

    if (patterns.length > 0) {
      lines.push('PATTERNS THAT WORK IN THIS WORKBOOK:');
      patterns.forEach(function(p) {
        lines.push('  ' + p.description + ' → ' + p.formula);
      });
    }

    return lines.length > 0 ? lines.join('\n') : '';
  },

  _save_: function(wb) {
    try {
      var serialized = JSON.stringify(wb);
      // DocumentProperties has a 9KB per-key limit.
      // If we're close, prune learnedPatterns first (annotations are more important).
      if (serialized.length > 8500) {
        wb.learnedPatterns = wb.learnedPatterns.slice(0, 20);
        serialized = JSON.stringify(wb);
      }
      PropertiesService.getDocumentProperties().setProperty(MEM_KEYS_.WORKBOOK, serialized);
    } catch (e) {
      logError_('Memory', 'Workbook memory save failed: ' + e.message);
    }
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — USER PREFERENCE MEMORY
// UserProperties: cross-spreadsheet, never expires, learned from behavior.
// ─────────────────────────────────────────────────────────────────────────────

var userPreferenceMemory_ = {

  DEFAULTS_: {
    formulaStyle: {
      preferArrayFormulas: false,    // ARRAYFORMULA vs traditional
      preferNamedRanges: false,      // SalesData!A:A vs Sheet1!A:A
      preferXLOOKUP: false,         // XLOOKUP vs VLOOKUP (XLOOKUP is newer/cleaner)
      absoluteRowRefs: true,         // A$1 locking preference for draggable formulas
      openEndedRanges: false         // A:A vs A2:A500 (open-ended is lazy but common)
    },
    verbosity: 'balanced',           // 'terse' | 'balanced' | 'detailed' | 'technical'
    preferredChartTypes: [],         // Populated from usage. [] means no preference yet.
    functionBlacklist: [],           // Functions user has explicitly rejected
    functionWhitelist: [],           // Functions user has explicitly requested
    rejectionReasons: [],            // { formula, reason, count }
    sessionCount: 0,
    totalRequests: 0,
    firstUsed: null,
    lastUsed: null
  },

  /**
   * Get user preferences. Merges stored preferences with defaults.
   * Why merge with defaults? If we add a new preference field in a future
   * version, existing users' stored prefs won't have it — the merge ensures
   * they always get a fully-populated preference object.
   */
  get: function() {
    try {
      var raw = PropertiesService.getUserProperties().getProperty(MEM_KEYS_.USER_PREFS);
      if (!raw) return this._clone_(this.DEFAULTS_);

      var stored = JSON.parse(raw);
      // Deep merge: stored values win, missing keys fall back to defaults
      return this._merge_(this.DEFAULTS_, stored);
    } catch (e) {
      logWarn_('Memory', 'User prefs read failed: ' + e.message);
      return this._clone_(this.DEFAULTS_);
    }
  },

  /**
   * Apply a partial update (patch) to user preferences.
   * Called explicitly when the user changes a setting in the sidebar.
   * Example: MEMORY.prefs.update({ verbosity: 'terse' })
   */
  update: function(patch) {
    var prefs = this.get();
    var updated = this._merge_(prefs, patch);
    updated.lastUsed = new Date().toISOString();
    this._save_(updated);
    logInfo_('Memory', 'User prefs updated', { keys: Object.keys(patch) });
  },

  /**
   * Observe a user-accepted formula output and learn from it.
   *
   * What we learn:
   *   - Which functions were used (add to whitelist signal)
   *   - Whether it used named ranges (update formulaStyle.preferNamedRanges)
   *   - Whether it used XLOOKUP or VLOOKUP (update preferXLOOKUP)
   *   - Whether it was an ARRAYFORMULA (update preferArrayFormulas)
   *
   * This is passive learning — we observe behavior, we don't ask the user.
   * Cursor does the same: it learns from which suggestions you accept.
   */
  observeAccepted: function(formula) {
    if (!formula || !formula.startsWith('=')) return;

    var prefs = this.get();
    var formulaUpper = formula.toUpperCase();

    // Learn XLOOKUP preference
    if (formulaUpper.indexOf('XLOOKUP') !== -1) {
      prefs.formulaStyle.preferXLOOKUP = true;
    }

    // Learn ARRAYFORMULA preference
    if (formulaUpper.indexOf('ARRAYFORMULA') !== -1) {
      prefs.formulaStyle.preferArrayFormulas = true;
    }

    // Extract function names and add to whitelist (functions the user implicitly approves)
    var functions = formula.match(/\b([A-Z_][A-Z0-9_]*)\s*\(/g) || [];
    functions.forEach(function(fn) {
      var name = fn.replace(/\s*\($/, '').trim();
      if (prefs.functionWhitelist.indexOf(name) === -1) {
        prefs.functionWhitelist.push(name);
      }
    });

    // Trim whitelist to last 30 unique functions
    prefs.functionWhitelist = prefs.functionWhitelist.slice(-30);
    prefs.totalRequests = (prefs.totalRequests || 0) + 1;

    this._save_(prefs);
  },

  /**
   * Observe a rejection and record why.
   * Called when the user clicks "Regenerate" or manually edits our output.
   *
   * @param {string} formula - The formula that was rejected
   * @param {string} reason  - 'regenerated' | 'edited' | 'deleted' | string
   */
  observeRejected: function(formula, reason) {
    if (!formula) return;

    var prefs = this.get();
    var formulaUpper = formula.toUpperCase();

    // If VLOOKUP is consistently rejected and XLOOKUP is accepted more,
    // flip the preference. This is a simple Bayesian signal.
    if (formulaUpper.indexOf('VLOOKUP') !== -1 && reason === 'regenerated') {
      prefs.functionBlacklist = prefs.functionBlacklist || [];
      if (prefs.functionBlacklist.indexOf('VLOOKUP') === -1) {
        prefs.functionBlacklist.push('VLOOKUP');
      }
    }

    // Record the rejection with reason (for diagnostic purposes + future prompting)
    prefs.rejectionReasons = prefs.rejectionReasons || [];
    prefs.rejectionReasons.push({
      formulaSnippet: formula.substring(0, 80),
      reason: reason || 'unknown',
      at: new Date().toISOString()
    });

    // Rolling window of 20 rejections
    if (prefs.rejectionReasons.length > 20) {
      prefs.rejectionReasons = prefs.rejectionReasons.slice(-20);
    }

    this._save_(prefs);
  },

  /**
   * Increment session counter. Called at session start.
   */
  incrementSession: function() {
    var prefs = this.get();
    prefs.sessionCount = (prefs.sessionCount || 0) + 1;
    prefs.lastUsed = new Date().toISOString();
    if (!prefs.firstUsed) prefs.firstUsed = prefs.lastUsed;
    this._save_(prefs);
  },

  /**
   * Build a style hint string for injection into system prompts.
   * Describes the user's learned preferences so every agent respects them
   * without being explicitly told every request.
   *
   * This is the key behavioural difference from V1: the LLM knows this user
   * prefers XLOOKUP before generating any formula. Not because the user told
   * it just now, but because the system observed it over time.
   */
  getStyleHint: function() {
    var prefs = this.get();
    var hints = [];

    if (prefs.formulaStyle.preferXLOOKUP) {
      hints.push('This user prefers XLOOKUP over VLOOKUP.');
    }
    if (prefs.formulaStyle.preferArrayFormulas) {
      hints.push('This user prefers ARRAYFORMULA patterns.');
    }
    if (prefs.formulaStyle.preferNamedRanges) {
      hints.push('Use named ranges when they exist (e.g. SalesData instead of Sales!A:A).');
    }
    if (prefs.functionBlacklist.length > 0) {
      hints.push('Avoid these functions (user has rejected them): ' +
        prefs.functionBlacklist.join(', ') + '.');
    }
    if (prefs.functionWhitelist.length > 0) {
      hints.push('This user has accepted formulas using: ' +
        prefs.functionWhitelist.slice(-10).join(', ') + '.');
    }

    var verbosityHint = {
      terse:     'Be brief. One sentence explanations only.',
      balanced:  '',  // Default — no special hint needed
      detailed:  'Explain your reasoning step by step.',
      technical: 'Use technical Sheets terminology. The user is an expert.'
    };
    if (verbosityHint[prefs.verbosity]) {
      hints.push(verbosityHint[prefs.verbosity]);
    }

    return hints.length > 0 ? ('USER PREFERENCES:\n  ' + hints.join('\n  ')) : '';
  },

  _save_: function(prefs) {
    try {
      PropertiesService.getUserProperties().setProperty(
        MEM_KEYS_.USER_PREFS,
        JSON.stringify(prefs)
      );
    } catch (e) {
      logError_('Memory', 'User prefs save failed: ' + e.message);
    }
  },

  _clone_: function(obj) {
    return JSON.parse(JSON.stringify(obj));
  },

  _merge_: function(base, override) {
    var result = this._clone_(base);
    Object.keys(override).forEach(function(key) {
      if (override[key] !== null &&
          typeof override[key] === 'object' &&
          !Array.isArray(override[key]) &&
          typeof result[key] === 'object') {
        result[key] = userPreferenceMemory_._merge_(result[key], override[key]);
      } else {
        result[key] = override[key];
      }
    });
    return result;
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — TASK MEMORY
// CacheService: ephemeral, 4-hour TTL. Multi-step plan state.
// ─────────────────────────────────────────────────────────────────────────────

var taskMemory_ = {

  /**
   * Get the current active task. Returns null if no task is in progress.
   *
   * Why CacheService (not PropertiesService)?
   * Task state is inherently ephemeral. A plan from 5 hours ago is almost
   * certainly stale — the user's spreadsheet has changed, the intent has
   * changed. Resuming an expired plan would cause confusion or data corruption.
   * CacheService's TTL acts as an automatic safety valve.
   */
  get: function() {
    try {
      var raw = CacheService.getUserCache().get(MEM_KEYS_.TASK);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      logWarn_('Memory', 'Task memory read failed: ' + e.message);
      return null;
    }
  },

  /**
   * Store a new task plan (emitted by the Planner Agent).
   * Overwrites any existing task — only one task can be active at a time.
   *
   * Task status lifecycle:
   *   pending → in_progress → completed | failed | awaiting_confirmation
   */
  set: function(plan) {
    var task = {
      taskId: 'task_' + new Date().getTime(),
      prompt: plan.prompt || '',
      intent: plan.intent || 'unknown',
      status: 'pending',
      steps: (plan.steps || []).map(function(s, i) {
        return {
          stepId: String(i + 1),
          agent: s.agent,
          description: s.description || '',
          status: 'pending',
          result: null,
          error: null,
          startedAt: null,
          completedAt: null
        };
      }),
      currentStepId: '1',
      accumulatedContext: {},   // Tool results passed between steps
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this._save_(task);
    logInfo_('Memory', 'Task set', { taskId: task.taskId, steps: task.steps.length });
    return task;
  },

  /**
   * Mark a step as started. Sets its status to 'in_progress'.
   */
  stepStart: function(stepId) {
    var task = this.get();
    if (!task) return;

    task.steps.forEach(function(s) {
      if (s.stepId === String(stepId)) {
        s.status = 'in_progress';
        s.startedAt = new Date().toISOString();
      }
    });
    task.currentStepId = String(stepId);
    task.status = 'in_progress';
    task.updatedAt = new Date().toISOString();
    this._save_(task);
  },

  /**
   * Mark a step as completed and store its result.
   * The result is merged into accumulatedContext so subsequent steps can
   * access the outputs of prior steps (e.g., step 2 uses the sheet name
   * written by step 1).
   */
  stepComplete: function(stepId, result) {
    var task = this.get();
    if (!task) return;

    task.steps.forEach(function(s) {
      if (s.stepId === String(stepId)) {
        s.status = 'completed';
        s.result = result;
        s.completedAt = new Date().toISOString();
      }
    });

    // Accumulate result into shared context for downstream steps
    if (result && typeof result === 'object') {
      Object.keys(result).forEach(function(k) {
        task.accumulatedContext['step' + stepId + '_' + k] = result[k];
      });
    }

    // Advance to next pending step
    var nextStep = task.steps.filter(function(s) {
      return s.status === 'pending';
    })[0];
    task.currentStepId = nextStep ? nextStep.stepId : null;
    task.updatedAt = new Date().toISOString();

    this._save_(task);
    logInfo_('Memory', 'Task step completed', { stepId: stepId });
  },

  /**
   * Mark a step as failed. Sets overall task status to 'failed'.
   */
  stepFail: function(stepId, reason) {
    var task = this.get();
    if (!task) return;

    task.steps.forEach(function(s) {
      if (s.stepId === String(stepId)) {
        s.status = 'failed';
        s.error = reason;
        s.completedAt = new Date().toISOString();
      }
    });

    task.status = 'failed';
    task.updatedAt = new Date().toISOString();
    this._save_(task);
    logWarn_('Memory', 'Task step failed', { stepId: stepId, reason: reason });
  },

  /**
   * Pause the task awaiting user confirmation.
   * Used by destructive steps that require explicit user approval.
   */
  awaitConfirmation: function(stepId, previewData) {
    var task = this.get();
    if (!task) return;

    task.status = 'awaiting_confirmation';
    task.pendingConfirmation = {
      stepId: String(stepId),
      previewData: previewData
    };
    task.updatedAt = new Date().toISOString();
    this._save_(task);
  },

  /**
   * Mark the entire task as complete and remove it from cache.
   */
  complete: function() {
    var task = this.get();
    if (task) {
      task.status = 'completed';
      task.completedAt = new Date().toISOString();
      logInfo_('Memory', 'Task completed', { taskId: task.taskId });
    }
    CacheService.getUserCache().remove(MEM_KEYS_.TASK);
  },

  /** Is there an active (non-completed) task? */
  isActive: function() {
    var task = this.get();
    return task !== null && task.status !== 'completed' && task.status !== 'failed';
  },

  _save_: function(task) {
    try {
      CacheService.getUserCache().put(
        MEM_KEYS_.TASK,
        JSON.stringify(task),
        CONFIG.MEMORY.TASK_TTL_SECONDS
      );
    } catch (e) {
      logError_('Memory', 'Task memory save failed: ' + e.message);
    }
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4b — TASK HISTORY
// UserProperties: persistent, rolling window. Distinct from taskMemory_ above
// (SECTION 4), which is the EPHEMERAL current-task-in-progress state
// (CacheService, 4-hour TTL, wiped on completion). Task History is a
// permanent record of what was attempted — this is what lets memory
// automatically influence future planning: Planner.js's generatePlan()
// injects getContextHint(intent) into its system prompt on every call, so
// the planner LLM sees "you've done this kind of task N times before, M
// succeeded, here's the step pattern that usually works" without anything
// extra required from the caller.
// ─────────────────────────────────────────────────────────────────────────────

var taskHistoryMemory_ = {

  MAX_ENTRIES: 30,

  /**
   * Record a completed or failed task. Called from Planner.js when a plan
   * finishes (PLAN_COMPLETED) or a step fails (STEP_FAILED).
   *
   * @param {object} entry
   *   taskId, intent, prompt, status ('completed'|'failed'), stepCount, stepTools[]
   */
  record: function (entry) {
    var history = this._load_();

    var record = {
      taskId: entry.taskId || ('task_' + new Date().getTime()),
      intent: entry.intent || 'unknown',
      prompt: (entry.prompt || '').substring(0, 150),
      status: entry.status || 'completed',
      stepCount: entry.stepCount || 0,
      stepTools: entry.stepTools || [],
      completedAt: new Date().toISOString()
    };

    history.unshift(record);
    if (history.length > this.MAX_ENTRIES) {
      history = history.slice(0, this.MAX_ENTRIES);
    }

    this._save_(history);
    logInfo_('Memory', 'Task history recorded', { intent: record.intent, status: record.status });
    return record.taskId;
  },

  /** Most recent N task history entries, across all intents. */
  getRecent: function (n) {
    return this._load_().slice(0, n || 10);
  },

  /** Past tasks with the same intent, most recent first. */
  getSimilar: function (intent, n) {
    return this._load_().filter(function (t) { return t.intent === intent; }).slice(0, n || 5);
  },

  /**
   * Builds a prompt-injection hint for a given intent: success rate over
   * past attempts, plus the most common step-tool sequence among the
   * successful ones (a soft "here's what usually works" signal — the
   * planner LLM is never forced to follow it).
   */
  getContextHint: function (intent) {
    var similar = this.getSimilar(intent, 10);
    if (similar.length === 0) return '';

    var completed = similar.filter(function (t) { return t.status === 'completed'; });
    var lines = ['TASK HISTORY for "' + intent + '": ' + completed.length + '/' + similar.length + ' past attempts succeeded.'];

    var patternCounts = {};
    completed.forEach(function (t) {
      var key = (t.stepTools || []).join(' -> ');
      if (!key) return;
      patternCounts[key] = (patternCounts[key] || 0) + 1;
    });
    var bestPattern = null, bestCount = 0;
    Object.keys(patternCounts).forEach(function (k) {
      if (patternCounts[k] > bestCount) { bestPattern = k; bestCount = patternCounts[k]; }
    });
    if (bestPattern) lines.push('Common successful step pattern: ' + bestPattern);

    return lines.join('\n');
  },

  _load_: function () {
    try {
      var raw = PropertiesService.getUserProperties().getProperty(MEM_KEYS_.TASK_HISTORY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  },

  _save_: function (history) {
    try {
      var serialized = JSON.stringify(history);
      // Safety: trim to fewer entries if approaching the 9KB per-key limit.
      if (serialized.length > 8000) {
        history = history.slice(0, 15);
        serialized = JSON.stringify(history);
      }
      PropertiesService.getUserProperties().setProperty(MEM_KEYS_.TASK_HISTORY, serialized);
    } catch (e) {
      logError_('Memory', 'Task history save failed: ' + e.message);
    }
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — RECENT OPERATIONS
// UserProperties: persistent, rolling window of 25. The "history panel".
// ─────────────────────────────────────────────────────────────────────────────

var recentOperations_ = {

  MAX_OPS: 25,

  /**
   * Record a completed operation. Called by every destructive tool in ToolRegistry.
   *
   * @param {object} op
   *   type:         'insert_formula'|'write_cells'|'create_chart'|'fetch_api'|
   *                 'run_sql'|'generate_pivot'|'generate_dashboard'|'undo'
   *   description:  Human-readable. e.g. "Inserted =SUMIF(...) in Sales!D5"
   *   sheetName:    Active sheet name
   *   range:        A1 notation of affected range (optional)
   *   undoable:     boolean — can this be undone via undoLastAction()?
   *   metadata:     any additional context (rows written, chart type, etc.)
   */
  record: function(op) {
    var ops = this._load_();

    var record = {
      opId: 'op_' + new Date().getTime(),
      type: op.type || 'unknown',
      description: (op.description || '').substring(0, 200),
      spreadsheetId: op.spreadsheetId ||
        SpreadsheetApp.getActiveSpreadsheet().getId(),
      sheetName: op.sheetName || '',
      range: op.range || '',
      undoable: op.undoable === true,
      undone: false,
      timestamp: new Date().toISOString(),
      metadata: op.metadata || {}
    };

    ops.unshift(record); // Newest first

    // Rolling window — evict oldest when over limit
    if (ops.length > this.MAX_OPS) {
      ops = ops.slice(0, this.MAX_OPS);
    }

    this._save_(ops);
    logInfo_('Memory', 'Operation recorded', { type: record.type, opId: record.opId });
    return record.opId;
  },

  /**
   * Retrieve the N most recent operations.
   * @param {number} n - How many to return (default: 10, max: 25)
   */
  getRecent: function(n) {
    var ops = this._load_();
    return ops.slice(0, Math.min(n || 10, this.MAX_OPS));
  },

  /**
   * Get the most recent undoable operation.
   * Used by undoLastAction() and the sidebar to decide whether to show
   * the Undo button and what label to display ("Undo: Insert formula in D5").
   */
  getLastUndoable: function() {
    var ops = this._load_();
    for (var i = 0; i < ops.length; i++) {
      if (ops[i].undoable && !ops[i].undone) return ops[i];
    }
    return null;
  },

  /**
   * Mark an operation as undone. Called after undoLastAction() succeeds.
   * The operation stays in the list (for audit purposes) but is marked undone
   * so it won't be selected by getLastUndoable() again.
   */
  markUndone: function(opId) {
    var ops = this._load_();
    ops.forEach(function(op) {
      if (op.opId === opId) op.undone = true;
    });
    this._save_(ops);
  },

  /**
   * Returns a compact string for sidebar display.
   * Format: "Last 5 actions:\n  [✓] Insert formula in D5  2m ago\n  ..."
   */
  formatForDisplay: function(n) {
    var ops = this.getRecent(n || 5);
    if (ops.length === 0) return 'No recent operations.';

    return ops.map(function(op) {
      var icon = op.undone ? '[↩]' : op.undoable ? '[✓]' : '[ ]';
      var age = recentOperations_._relativeTime_(op.timestamp);
      return icon + ' ' + op.description + '  ' + age;
    }).join('\n');
  },

  _load_: function() {
    try {
      var raw = PropertiesService.getUserProperties().getProperty(MEM_KEYS_.RECENT_OPS);
      if (!raw) return [];
      return JSON.parse(raw);
    } catch (e) {
      return [];
    }
  },

  _save_: function(ops) {
    try {
      var serialized = JSON.stringify(ops);
      // Safety: if the serialized ops exceed 8KB (approaching the 9KB key limit),
      // trim to fewer entries. 8KB / 400 bytes per op ≈ 20 ops safe limit.
      if (serialized.length > 8000) {
        ops = ops.slice(0, 15);
        serialized = JSON.stringify(ops);
      }
      PropertiesService.getUserProperties().setProperty(MEM_KEYS_.RECENT_OPS, serialized);
    } catch (e) {
      logError_('Memory', 'Recent ops save failed: ' + e.message);
    }
  },

  _relativeTime_: function(isoTimestamp) {
    try {
      var diff = Math.floor((Date.now() - new Date(isoTimestamp).getTime()) / 1000);
      if (diff < 60) return diff + 's ago';
      if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
      if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
      return Math.floor(diff / 86400) + 'd ago';
    } catch (e) {
      return '';
    }
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — PUBLIC MEMORY FACADE
// Single global object. All code accesses memory through this interface.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MEMORY — The global memory facade.
 *
 * Usage from anywhere in the codebase:
 *   MEMORY.conversation.append({ role: 'user', content: prompt })
 *   MEMORY.workbook.learn('SUMIF on Status column', '=SUMIF(D:D,"Active",C:C)')
 *   MEMORY.prefs.getStyleHint()
 *   MEMORY.ops.record({ type: 'insert_formula', description: '...', undoable: true })
 */
var MEMORY = {
  conversation: conversationMemory_,
  workbook:     workbookMemory_,
  prefs:        userPreferenceMemory_,
  task:         taskMemory_,
  taskHistory:  taskHistoryMemory_,
  ops:          recentOperations_,

  /**
   * Initialize all memory subsystems for a new request.
   * Called once per handleRequest() before anything else.
   * Returns the memory context object that agents can read from.
   *
   * This is the equivalent of Cursor loading your .cursorrules, project
   * index, and previous chat summary when you open a file.
   */
  initSession: function() {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var spreadsheetId = ss.getId();
    var activeSheet = ss.getActiveSheet();

    // 1. Ensure workbook memory exists for this spreadsheet
    var wb = this.workbook.get();
    if (!wb) {
      wb = this.workbook.init(spreadsheetId, ss.getName(), '');
    }
    this.workbook.touch(activeSheet.getName(), activeSheet.getActiveCell().getA1Notation());

    // 2. Ensure conversation session is initialized
    this.conversation.init(spreadsheetId);

    // 3. Increment session counter in user prefs
    this.prefs.incrementSession();

    logInfo_('Memory', 'Session initialized', {
      spreadsheetId: spreadsheetId,
      hasWorkbookMemory: wb !== null,
      hasActiveTask: this.task.isActive()
    });

    return {
      workbookHint: this.workbook.getContextHint(),
      styleHint:    this.prefs.getStyleHint(),
      sessionSummary: this.conversation.getSummary(),
      activeTask:   this.task.isActive() ? this.task.get() : null
    };
  },

  /**
   * Build the full memory context string to inject into agent system prompts
   * (and, when `intent` is given, the Planner's system prompt too — this is
   * what makes memory automatically influence future planning: Planner.js's
   * generatePlan() passes its pre-classified intent here on every call, with
   * no extra step required from the caller). Empty sections are omitted —
   * no padding, no boilerplate.
   *
   * @param {string} [intent] - if provided, includes taskHistory's
   *   getContextHint(intent) (past success rate + common step pattern for
   *   this intent). Omitted for agent calls that don't have an intent handy.
   */
  buildContextString: function(intent) {
    var parts = [];

    var workbookHint = this.workbook.getContextHint();
    if (workbookHint) parts.push(workbookHint);

    var styleHint = this.prefs.getStyleHint();
    if (styleHint) parts.push(styleHint);

    var sessionSummary = this.conversation.getSummary();
    if (sessionSummary) parts.push(sessionSummary);

    if (intent) {
      var taskHint = this.taskHistory.getContextHint(intent);
      if (taskHint) parts.push(taskHint);
    }

    return parts.join('\n\n');
  },

  /**
   * Wipe all memory for the current user (nuclear option).
   * Called from the sidebar's "Reset All Memory" button.
   * Does NOT clear workbook memory (DocumentProperties) — that requires
   * explicit workbook.clear() because it affects all users of that spreadsheet.
   */
  clearAll: function() {
    CacheService.getUserCache().removeAll([MEM_KEYS_.CONVERSATION, MEM_KEYS_.TASK]);
    var userProps = PropertiesService.getUserProperties();
    userProps.deleteProperty(MEM_KEYS_.USER_PREFS);
    userProps.deleteProperty(MEM_KEYS_.RECENT_OPS);
    userProps.deleteProperty(MEM_KEYS_.TASK_HISTORY);
    // Leave conversation summaries — they're per-workbook and non-sensitive
    logInfo_('Memory', 'All user memory cleared');
  }
};
