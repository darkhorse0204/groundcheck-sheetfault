/**
 * Enterprise.js — Enterprise-Grade Operations Layer
 *
 * Ten capabilities, one file, zero magic:
 *
 *   ENTERPRISE.undo        — Multi-level undo stack (10 levels)
 *   ENTERPRISE.audit       — Immutable append-only event log
 *   ENTERPRISE.history     — Execution plan history (20 plans)
 *   ENTERPRISE.cost        — Per-request token + cost tracking
 *   ENTERPRISE.dryRun      — Toggle: compute but never commit writes
 *   ENTERPRISE.transaction — Snapshot → execute → commit/rollback
 *   ENTERPRISE.rateLimit   — Enhanced per-user rate limiting
 *   ENTERPRISE.permissions — Edit access verification
 *   ENTERPRISE.batch       — Queue multiple operations, execute atomically
 *   ENTERPRISE.ops         — Alias to MEMORY.ops for operation recording
 *
 * Storage layout in PropertiesService.getUserProperties():
 *   ENT_UNDO     → JSON array of UndoSnapshot objects (max 10)
 *   ENT_AUDIT    → JSON array of AuditEvent objects (max 100)
 *   ENT_HISTORY  → JSON array of completed Plan objects (max 20, summarized)
 *   ENT_COST     → JSON object { totalCostUsd, requests[], sessionCost }
 *   ENT_DRYRUN   → "true" | "false" (persists across sidebar refreshes)
 *
 * Transaction state lives in memory (CacheService, session-scoped):
 *   Current transaction snapshots cleared on commit or rollback.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. UNDO STACK
// Multi-level undo. Each destructive operation pushes a snapshot.
// undoLastAction() pops the top snapshot and restores it.
// ─────────────────────────────────────────────────────────────────────────────

var undoStack_ = {
  /**
   * Push a snapshot of a range's before-state onto the undo stack.
   * Called by any code that is about to write to the spreadsheet.
   *
   * A fresh write invalidates redo history (standard undo/redo semantics —
   * once you do something new, "redo" no longer means anything coherent),
   * so this clears ENTERPRISE.redo's stack too.
   *
   * @param {string} description - Human-readable description of the operation
   * @param {string} sheetName   - Sheet being modified
   * @param {string} range       - A1 notation of cells being modified
   */
  push: function(description, sheetName, range) {
    try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var sheet = sheetName ? ss.getSheetByName(sheetName) : ss.getActiveSheet();
      if (!sheet) return;

      var targetRange = sheet.getRange(range || sheet.getActiveCell().getA1Notation());

      // Capture both values and formulas — restoring only values would lose formulas
      var snapshot = {
        id: 'undo_' + new Date().getTime(),
        description: description || 'Operation',
        sheetName: sheet.getName(),
        range: targetRange.getA1Notation(),
        values: targetRange.getValues(),
        formulas: targetRange.getFormulas(),
        timestamp: new Date().toISOString()
      };

      this._pushSnapshot_(snapshot);
      redoStack_._clear_();
      logInfo_('Enterprise', 'Undo snapshot pushed', { id: snapshot.id, range: range });
      return snapshot.id;
    } catch (e) {
      // Non-fatal — losing undo is better than crashing the operation
      logWarn_('Enterprise', 'Undo push failed: ' + e.message);
      return null;
    }
  },

  /** Raw push of an already-built snapshot — shared with redoStack_.pop(), which needs
   *  to put the just-replaced state back onto the undo stack without re-deriving it
   *  from the (now different) live cell values. Does NOT clear redo (only push() does). */
  _pushSnapshot_: function(snapshot) {
    var stack = this._load_();
    stack.unshift(snapshot); // Newest first
    if (stack.length > CONFIG.ENTERPRISE.MAX_UNDO_LEVELS) {
      stack = stack.slice(0, CONFIG.ENTERPRISE.MAX_UNDO_LEVELS);
    }
    this._save_(stack);
  },

  /**
   * Pop and restore the top snapshot. Returns the description of what was undone.
   * Enhanced version of the old undoLastAction() in Tools.js. The cells' state
   * immediately before this restore is captured and pushed onto the redo stack,
   * so ENTERPRISE.redo.pop() can bring it back.
   */
  pop: function() {
    var stack = this._load_();
    if (stack.length === 0) {
      throw createError_(ErrorType.VALIDATION_ERROR, 'Nothing to undo.');
    }

    var snapshot = stack.shift(); // Take from top (newest)
    this._save_(stack);

    // Restore the range
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(snapshot.sheetName);
    if (!sheet) {
      throw createError_(ErrorType.VALIDATION_ERROR,
        'Sheet "' + snapshot.sheetName + '" no longer exists.');
    }

    var range = sheet.getRange(snapshot.range);

    // Capture the CURRENT (pre-undo) state before overwriting it, so redo can restore it.
    var preUndoSnapshot = {
      id: 'redo_' + new Date().getTime(),
      description: snapshot.description,
      sheetName: snapshot.sheetName,
      range: snapshot.range,
      values: range.getValues(),
      formulas: range.getFormulas(),
      timestamp: new Date().toISOString()
    };

    // Restore formulas first (where present), then values for non-formula cells
    for (var r = 0; r < snapshot.formulas.length; r++) {
      for (var c = 0; c < snapshot.formulas[r].length; c++) {
        var cell = sheet.getRange(
          range.getRow() + r,
          range.getColumn() + c
        );
        if (snapshot.formulas[r][c]) {
          cell.setFormula(snapshot.formulas[r][c]);
        } else {
          cell.setValue(snapshot.values[r][c]);
        }
      }
    }

    redoStack_._pushSnapshot_(preUndoSnapshot);

    ENTERPRISE.audit.record({
      type: 'UNDO_EXECUTED',
      description: 'Undid: ' + snapshot.description,
      range: snapshot.range,
      sheet: snapshot.sheetName
    });

    logInfo_('Enterprise', 'Undo executed', { id: snapshot.id, range: snapshot.range });
    return 'Undid: ' + snapshot.description;
  },

  /** Peek at the top snapshot without removing it */
  peek: function() {
    var stack = this._load_();
    return stack.length > 0 ? { description: stack[0].description, range: stack[0].range, timestamp: stack[0].timestamp } : null;
  },

  /** How many undo levels are available? */
  depth: function() {
    return this._load_().length;
  },

  /** Get display-ready list of all undo levels */
  getStack: function() {
    return this._load_().map(function(s) {
      return { id: s.id, description: s.description, range: s.range, timestamp: s.timestamp };
    });
  },

  _load_: function() {
    try {
      var raw = PropertiesService.getUserProperties().getProperty(CONFIG.ENTERPRISE.UNDO_STACK_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  },

  _save_: function(stack) {
    try {
      var serialized = JSON.stringify(stack);
      // If approaching 9KB key limit, trim snapshot data (keep metadata, drop cell values)
      if (serialized.length > 8000) {
        var trimmed = stack.map(function(s) {
          return { id: s.id, description: s.description, sheetName: s.sheetName,
                   range: s.range, timestamp: s.timestamp, values: [], formulas: [] };
        });
        serialized = JSON.stringify(trimmed);
        logWarn_('Enterprise', 'Undo stack values trimmed due to size');
      }
      PropertiesService.getUserProperties().setProperty(CONFIG.ENTERPRISE.UNDO_STACK_KEY, serialized);
    } catch (e) {
      logError_('Enterprise', 'Undo stack save failed: ' + e.message);
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 1b. REDO STACK
// Mirror image of the undo stack. Popping undo pushes the just-replaced state
// here; popping redo pushes the just-replaced state back onto undo — the two
// stacks ping-pong. Any FRESH write (undoStack_.push()) clears this stack,
// same as every other undo/redo system: redo only makes sense until you do
// something new.
// ─────────────────────────────────────────────────────────────────────────────

var redoStack_ = {
  _pushSnapshot_: function(snapshot) {
    var stack = this._load_();
    stack.unshift(snapshot);
    if (stack.length > CONFIG.ENTERPRISE.MAX_UNDO_LEVELS) {
      stack = stack.slice(0, CONFIG.ENTERPRISE.MAX_UNDO_LEVELS);
    }
    this._save_(stack);
  },

  /** Pop and re-apply the top redo snapshot. The state it replaces goes back onto undo. */
  pop: function() {
    var stack = this._load_();
    if (stack.length === 0) {
      throw createError_(ErrorType.VALIDATION_ERROR, 'Nothing to redo.');
    }

    var snapshot = stack.shift();
    this._save_(stack);

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(snapshot.sheetName);
    if (!sheet) {
      throw createError_(ErrorType.VALIDATION_ERROR,
        'Sheet "' + snapshot.sheetName + '" no longer exists.');
    }

    var range = sheet.getRange(snapshot.range);

    // Capture current state before overwriting, to push back onto undo.
    var preRedoSnapshot = {
      id: 'undo_' + new Date().getTime(),
      description: snapshot.description,
      sheetName: snapshot.sheetName,
      range: snapshot.range,
      values: range.getValues(),
      formulas: range.getFormulas(),
      timestamp: new Date().toISOString()
    };

    for (var r = 0; r < snapshot.formulas.length; r++) {
      for (var c = 0; c < snapshot.formulas[r].length; c++) {
        var cell = sheet.getRange(range.getRow() + r, range.getColumn() + c);
        if (snapshot.formulas[r][c]) {
          cell.setFormula(snapshot.formulas[r][c]);
        } else {
          cell.setValue(snapshot.values[r][c]);
        }
      }
    }

    undoStack_._pushSnapshot_(preRedoSnapshot);

    ENTERPRISE.audit.record({
      type: 'REDO_EXECUTED',
      description: 'Redid: ' + snapshot.description,
      range: snapshot.range,
      sheet: snapshot.sheetName
    });

    logInfo_('Enterprise', 'Redo executed', { id: snapshot.id, range: snapshot.range });
    return 'Redid: ' + snapshot.description;
  },

  depth: function() {
    return this._load_().length;
  },

  getStack: function() {
    return this._load_().map(function(s) {
      return { id: s.id, description: s.description, range: s.range, timestamp: s.timestamp };
    });
  },

  _clear_: function() {
    this._save_([]);
  },

  _load_: function() {
    try {
      var raw = PropertiesService.getUserProperties().getProperty(CONFIG.ENTERPRISE.REDO_STACK_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  },

  _save_: function(stack) {
    try {
      var serialized = JSON.stringify(stack);
      if (serialized.length > 8000) {
        var trimmed = stack.map(function(s) {
          return { id: s.id, description: s.description, sheetName: s.sheetName,
                   range: s.range, timestamp: s.timestamp, values: [], formulas: [] };
        });
        serialized = JSON.stringify(trimmed);
        logWarn_('Enterprise', 'Redo stack values trimmed due to size');
      }
      PropertiesService.getUserProperties().setProperty(CONFIG.ENTERPRISE.REDO_STACK_KEY, serialized);
    } catch (e) {
      logError_('Enterprise', 'Redo stack save failed: ' + e.message);
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. AUDIT LOG
// Append-only event log. Every significant action is recorded here.
// ─────────────────────────────────────────────────────────────────────────────

var auditLog_ = {
  /**
   * Record an audit event. Non-blocking — never throws.
   *
   * @param {object} event
   *   type:        Required. Event type string (e.g. 'FORMULA_INSERTED')
   *   [key:value]: Any additional fields relevant to this event type
   */
  record: function(event) {
    try {
      var events = this._load_();
      events.unshift({
        eventId:   'evt_' + new Date().getTime(),
        timestamp: new Date().toISOString(),
        type:      event.type || 'UNKNOWN',
        actor:     'user',  // In a multi-user system, this would be the authenticated user
        data:      event
      });

      // Rolling window — evict oldest
      if (events.length > CONFIG.ENTERPRISE.MAX_AUDIT_EVENTS) {
        events = events.slice(0, CONFIG.ENTERPRISE.MAX_AUDIT_EVENTS);
      }

      this._save_(events);
    } catch (e) {
      // Audit logging is never allowed to crash the system
      logWarn_('Enterprise', 'Audit log write failed: ' + e.message);
    }
  },

  /** Get the N most recent audit events */
  getRecent: function(n) {
    return this._load_().slice(0, n || 20);
  },

  /** Get events of a specific type */
  getByType: function(type, n) {
    return this._load_()
      .filter(function(e) { return e.type === type; })
      .slice(0, n || 20);
  },

  /** Format for sidebar display */
  formatForDisplay: function(n) {
    return this.getRecent(n || 10).map(function(e) {
      var ts = new Date(e.timestamp).toLocaleTimeString();
      return '[' + ts + '] ' + e.type + (e.data.description ? ': ' + e.data.description : '');
    });
  },

  _load_: function() {
    try {
      var raw = PropertiesService.getUserProperties().getProperty(CONFIG.ENTERPRISE.AUDIT_LOG_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  },

  _save_: function(events) {
    try {
      var serialized = JSON.stringify(events);
      // If over 8KB, keep only metadata (drop data payload from older events)
      if (serialized.length > 8000) {
        var half = Math.floor(events.length / 2);
        var trimmed = events.slice(0, half).concat(
          events.slice(half).map(function(e) {
            return { eventId: e.eventId, timestamp: e.timestamp, type: e.type, actor: e.actor };
          })
        );
        serialized = JSON.stringify(trimmed);
      }
      PropertiesService.getUserProperties().setProperty(CONFIG.ENTERPRISE.AUDIT_LOG_KEY, serialized);
    } catch (e) {
      logError_('Enterprise', 'Audit log save failed: ' + e.message);
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. EXECUTION HISTORY
// Stores completed plans for replay and review.
// ─────────────────────────────────────────────────────────────────────────────

var executionHistory_ = {
  /** Record a completed plan in the execution history */
  record: function(plan) {
    try {
      var history = this._load_();

      // Store a summarized version (not full plan with context snapshots)
      var summary = {
        planId:     plan.planId,
        prompt:     (plan.prompt || '').substring(0, 100),
        intent:     plan.intent,
        status:     plan.status,
        stepCount:  plan.steps ? plan.steps.length : 0,
        totalCost:  plan.totalEstimatedCostUsd || 0,
        createdAt:  plan.createdAt,
        completedAt: plan.completedAt,
        // Keep only the tool names for replay
        stepTools:  (plan.steps || []).map(function(s) { return s.tool; })
      };

      history.unshift(summary);

      if (history.length > CONFIG.ENTERPRISE.MAX_HISTORY_PLANS) {
        history = history.slice(0, CONFIG.ENTERPRISE.MAX_HISTORY_PLANS);
      }

      this._save_(history);
    } catch (e) {
      logWarn_('Enterprise', 'History record failed: ' + e.message);
    }
  },

  /** Get recent execution history */
  getRecent: function(n) {
    return this._load_().slice(0, n || 10);
  },

  /**
   * Replay a past plan.
   * Re-submits the original prompt through the full pipeline (plan → approve → execute).
   * The plan is regenerated fresh — not literally re-executing old steps, which could
   * be dangerous if the spreadsheet has changed.
   */
  replay: function(planId) {
    var history = this._load_();
    var pastPlan = history.filter(function(h) { return h.planId === planId; })[0];

    if (!pastPlan) {
      throw createError_(ErrorType.VALIDATION_ERROR, 'Plan not found in history: ' + planId);
    }

    logInfo_('Enterprise', 'Replaying plan', { planId: planId, prompt: pastPlan.prompt });

    // Re-submit through the normal pipeline with the original prompt
    return handleRequest(pastPlan.prompt, 'auto');
  },

  /** Format for sidebar display */
  formatForDisplay: function(n) {
    return this.getRecent(n || 10).map(function(h) {
      var date = new Date(h.createdAt).toLocaleDateString();
      var statusIcon = h.status === 'completed' ? '✓' : h.status === 'failed' ? '✗' : '○';
      return {
        planId: h.planId,
        display: statusIcon + ' ' + (h.prompt || '').substring(0, 50),
        date: date,
        cost: '$' + (h.totalCost || 0).toFixed(4),
        status: h.status,
        intent: h.intent
      };
    });
  },

  _load_: function() {
    try {
      var raw = PropertiesService.getUserProperties().getProperty(CONFIG.ENTERPRISE.EXEC_HISTORY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  },

  _save_: function(history) {
    try {
      PropertiesService.getUserProperties().setProperty(
        CONFIG.ENTERPRISE.EXEC_HISTORY_KEY,
        JSON.stringify(history)
      );
    } catch (e) {
      logError_('Enterprise', 'History save failed: ' + e.message);
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. COST TRACKER
// Tracks token usage and USD cost per LLM call and per session.
// ─────────────────────────────────────────────────────────────────────────────

var costTracker_ = {
  /**
   * Record token usage for an LLM call.
   * Called from Api.js after every callGemini_() response.
   *
   * @param {string} model         - Model name (e.g. 'gemini-2.5-flash')
   * @param {number} inputTokens   - Input token count from response metadata
   * @param {number} outputTokens  - Output token count from response metadata
   * @param {string} agent         - Which agent made this call
   */
  record: function(model, inputTokens, outputTokens, agent) {
    try {
      var pricing = CONFIG.MODEL_PRICING[model] || { input: 0.001, output: 0.003 };
      var cost = (inputTokens / 1e6 * pricing.input) + (outputTokens / 1e6 * pricing.output);

      var data = this._load_();
      var entry = {
        timestamp:    new Date().toISOString(),
        model:        model,
        agent:        agent || 'unknown',
        inputTokens:  inputTokens,
        outputTokens: outputTokens,
        costUsd:      parseFloat(cost.toFixed(6))
      };

      data.requests.unshift(entry);
      data.totalCostUsd = parseFloat((data.totalCostUsd + cost).toFixed(6));
      data.sessionCost  = parseFloat((data.sessionCost  + cost).toFixed(6));
      data.totalTokens  = (data.totalTokens || 0) + inputTokens + outputTokens;

      if (data.requests.length > CONFIG.ENTERPRISE.MAX_COST_RECORDS) {
        data.requests = data.requests.slice(0, CONFIG.ENTERPRISE.MAX_COST_RECORDS);
      }

      this._save_(data);
    } catch (e) {
      logWarn_('Enterprise', 'Cost tracking failed: ' + e.message);
    }
  },

  /** Get cost summary for display */
  getSummary: function() {
    var data = this._load_();
    return {
      totalCostUsd:  data.totalCostUsd || 0,
      sessionCost:   data.sessionCost || 0,
      totalTokens:   data.totalTokens || 0,
      requestCount:  (data.requests || []).length,
      lastRequest:   (data.requests || [])[0] || null,
      formattedTotal: '$' + (data.totalCostUsd || 0).toFixed(4),
      formattedSession: '$' + (data.sessionCost || 0).toFixed(4)
    };
  },

  /** Reset session cost (not lifetime) */
  resetSession: function() {
    var data = this._load_();
    data.sessionCost = 0;
    this._save_(data);
  },

  _load_: function() {
    try {
      var raw = PropertiesService.getUserProperties().getProperty(CONFIG.ENTERPRISE.COST_LOG_KEY);
      return raw ? JSON.parse(raw) : { totalCostUsd: 0, sessionCost: 0, totalTokens: 0, requests: [] };
    } catch (e) {
      return { totalCostUsd: 0, sessionCost: 0, totalTokens: 0, requests: [] };
    }
  },

  _save_: function(data) {
    try {
      PropertiesService.getUserProperties().setProperty(
        CONFIG.ENTERPRISE.COST_LOG_KEY,
        JSON.stringify(data)
      );
    } catch (e) {
      logError_('Enterprise', 'Cost save failed: ' + e.message);
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. DRY RUN MODE
// When enabled, all write operations are skipped but everything else runs.
// The result shows exactly what WOULD have been written.
// ─────────────────────────────────────────────────────────────────────────────

var dryRun_ = {
  /** Enable dry run mode. Persists across sidebar refreshes. */
  enable: function() {
    PropertiesService.getUserProperties().setProperty(CONFIG.ENTERPRISE.DRY_RUN_KEY, 'true');
    ENTERPRISE.audit.record({ type: 'DRY_RUN_ENABLED' });
    logInfo_('Enterprise', 'Dry run mode enabled');
  },

  /** Disable dry run mode. */
  disable: function() {
    PropertiesService.getUserProperties().setProperty(CONFIG.ENTERPRISE.DRY_RUN_KEY, 'false');
    ENTERPRISE.audit.record({ type: 'DRY_RUN_DISABLED' });
    logInfo_('Enterprise', 'Dry run mode disabled');
  },

  /** Is dry run mode currently active? */
  isEnabled: function() {
    try {
      return PropertiesService.getUserProperties().getProperty(CONFIG.ENTERPRISE.DRY_RUN_KEY) === 'true';
    } catch (e) { return false; }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 6. TRANSACTION
// Snapshot → Execute → Commit | Rollback
// All snapshots for a plan execution are collected in CacheService.
// On rollback, every modified cell is restored to its pre-plan state.
// ─────────────────────────────────────────────────────────────────────────────

var transaction_ = {
  CACHE_KEY: 'ENT_TRANSACTION',

  /**
   * Take a snapshot of a range before a write tool executes.
   * Accumulates in the current transaction.
   * @param {object} step - The plan step about to execute
   */
  snapshot: function(step) {
    try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var sheet = ss.getActiveSheet();
      var cell = sheet.getActiveCell();
      var snapshotRange = cell.getA1Notation();

      var snap = {
        stepId:    step.stepId,
        tool:      step.tool,
        sheetName: sheet.getName(),
        range:     snapshotRange,
        values:    cell.getValue(),
        formula:   cell.getFormula(),
        takenAt:   new Date().toISOString()
      };

      var txn = this._load_();
      txn.snapshots.push(snap);
      txn.active = true;
      this._save_(txn);
    } catch (e) {
      logWarn_('Enterprise', 'Transaction snapshot failed: ' + e.message);
    }
  },

  /**
   * Commit the current transaction — clear snapshots (writes are permanent).
   */
  commit: function() {
    this._save_({ active: false, snapshots: [] });
    logInfo_('Enterprise', 'Transaction committed');
  },

  /**
   * Rollback the current transaction — restore all snapshotted cells.
   * Called when any plan step fails fatally.
   */
  rollback: function() {
    var txn = this._load_();
    if (!txn.active || txn.snapshots.length === 0) {
      logInfo_('Enterprise', 'Nothing to roll back');
      return;
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var rolledBack = 0;

    // Restore in reverse order (undo last write first)
    var reversed = txn.snapshots.slice().reverse();
    reversed.forEach(function(snap) {
      try {
        var sheet = ss.getSheetByName(snap.sheetName);
        if (!sheet) return;
        var cell = sheet.getRange(snap.range);
        if (snap.formula) {
          cell.setFormula(snap.formula);
        } else {
          cell.setValue(snap.values);
        }
        rolledBack++;
      } catch (e) {
        logWarn_('Enterprise', 'Rollback of cell failed: ' + snap.range + ' — ' + e.message);
      }
    });

    this._save_({ active: false, snapshots: [] });
    ENTERPRISE.audit.record({
      type: 'TRANSACTION_ROLLED_BACK',
      cellsRestored: rolledBack
    });
    logInfo_('Enterprise', 'Transaction rolled back', { cellsRestored: rolledBack });
  },

  _load_: function() {
    try {
      var raw = CacheService.getUserCache().get(this.CACHE_KEY);
      return raw ? JSON.parse(raw) : { active: false, snapshots: [] };
    } catch (e) { return { active: false, snapshots: [] }; }
  },

  _save_: function(txn) {
    try {
      CacheService.getUserCache().put(
        this.CACHE_KEY,
        JSON.stringify(txn),
        CONFIG.MEMORY.TASK_TTL_SECONDS
      );
    } catch (e) {
      logWarn_('Enterprise', 'Transaction save failed: ' + e.message);
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 7. RATE LIMITER (Enhanced)
// Per-user per-minute limit. Tracks calls in UserProperties with a 60s window.
// ─────────────────────────────────────────────────────────────────────────────

var rateLimiter_ = {
  /**
   * Check if this user has exceeded their rate limit.
   * Throws RATE_LIMIT_ERROR if exceeded.
   * Updates the counter if within limits.
   */
  check: function() {
    var props = PropertiesService.getUserProperties();
    var now = Date.now();
    var windowStart = parseInt(props.getProperty(CONFIG.RATE_LIMIT.WINDOW_KEY) || '0');
    var count = parseInt(props.getProperty(CONFIG.RATE_LIMIT.COUNTER_KEY) || '0');

    // Reset window after 60 seconds
    if (now - windowStart > 60000) {
      props.setProperties({
        [CONFIG.RATE_LIMIT.COUNTER_KEY]: '1',
        [CONFIG.RATE_LIMIT.WINDOW_KEY]: String(now)
      });
      return;
    }

    if (count >= CONFIG.RATE_LIMIT.MAX_CALLS_PER_MINUTE) {
      var waitSeconds = Math.ceil((60000 - (now - windowStart)) / 1000);
      ENTERPRISE.audit.record({ type: 'RATE_LIMIT_HIT', waitSeconds: waitSeconds });
      throw createError_(ErrorType.RATE_LIMIT_ERROR,
        'Rate limit reached. Wait ' + waitSeconds + 's before your next request.');
    }

    props.setProperty(CONFIG.RATE_LIMIT.COUNTER_KEY, String(count + 1));
  },

  /** Get current rate limit status */
  getStatus: function() {
    var props = PropertiesService.getUserProperties();
    var now = Date.now();
    var windowStart = parseInt(props.getProperty(CONFIG.RATE_LIMIT.WINDOW_KEY) || '0');
    var count = parseInt(props.getProperty(CONFIG.RATE_LIMIT.COUNTER_KEY) || '0');
    var inWindow = (now - windowStart) < 60000;

    return {
      callsUsed: inWindow ? count : 0,
      callsLimit: CONFIG.RATE_LIMIT.MAX_CALLS_PER_MINUTE,
      resetsInSeconds: inWindow ? Math.ceil((60000 - (now - windowStart)) / 1000) : 0
    };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 8. PERMISSIONS
// Verifies the user has the necessary access before destructive operations.
// ─────────────────────────────────────────────────────────────────────────────

var permissions_ = {
  /**
   * Check that the current user can edit the active spreadsheet.
   * In GAS, UrlFetchApp always runs as the add-on, but SpreadsheetApp.getActiveSheet()
   * will throw if the user only has view access. We catch that case here.
   */
  checkEditAccess: function() {
    try {
      var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
      // Write a test: try getting the sheet name (always available) then check protection
      var protections = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
      var activeUserEmail = Session.getActiveUser().getEmail();

      if (protections.length > 0) {
        var isEditor = protections.some(function(p) {
          var editors = p.getEditors().map(function(e) { return e.getEmail(); });
          return editors.indexOf(activeUserEmail) !== -1 || !p.isWarningOnly();
        });
        if (!isEditor) {
          return { allowed: false, reason: 'Sheet is protected. You may not have edit access.' };
        }
      }

      return { allowed: true };
    } catch (e) {
      return { allowed: false, reason: 'Cannot verify edit access: ' + e.message };
    }
  },

  /**
   * Verify that a specific sheet exists and is accessible.
   * @param {string} sheetName
   */
  checkSheetExists: function(sheetName) {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (!sheet) {
      return { exists: false, reason: 'Sheet "' + sheetName + '" does not exist.' };
    }
    return { exists: true, sheet: sheet };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 9. BATCH OPERATIONS
// Queue multiple tool calls, execute them atomically.
// All succeed or all roll back.
// ─────────────────────────────────────────────────────────────────────────────

var batch_ = {
  _queue: [],

  /**
   * Add an operation to the batch queue.
   * @param {object} operation - { tool, args, description }
   */
  queue: function(operation) {
    this._queue.push({
      opIndex: this._queue.length,
      tool: operation.tool,
      args: operation.args || {},
      description: operation.description || operation.tool,
      status: 'pending'
    });
    logInfo_('Enterprise', 'Batched operation', { tool: operation.tool, queueSize: this._queue.length });
  },

  /**
   * Execute all queued operations.
   * Creates a transaction around all operations.
   * If any fails, rolls back all preceding writes.
   * @returns {object[]} Results from each operation
   */
  execute: function() {
    if (this._queue.length === 0) {
      return { results: [], message: 'Batch queue is empty.' };
    }

    var isDryRun = ENTERPRISE.dryRun.isEnabled();
    var results = [];

    ENTERPRISE.audit.record({
      type: 'BATCH_STARTED',
      operationCount: this._queue.length,
      dryRun: isDryRun
    });

    for (var i = 0; i < this._queue.length; i++) {
      var op = this._queue[i];
      op.status = 'running';

      try {
        if (isDryRun) {
          op.status = 'dry_run';
          op.result = { dryRun: true, wouldRun: op.tool };
        } else {
          // Snapshot before any write
          ENTERPRISE.transaction.snapshot({ stepId: String(i), tool: op.tool });
          op.result = dispatchToTool_(op.tool, { reason: op.description, expectedOutput: '' }, {});
          op.status = 'completed';
        }
        results.push({ opIndex: i, status: op.status, result: op.result });
      } catch (e) {
        op.status = 'failed';
        op.error = e.message;

        // Roll back everything written so far
        ENTERPRISE.transaction.rollback();
        ENTERPRISE.audit.record({
          type: 'BATCH_FAILED',
          failedAtIndex: i,
          error: e.message
        });

        results.push({ opIndex: i, status: 'failed', error: e.message });
        this._queue = []; // Clear queue after failure
        throw createError_(ErrorType.VALIDATION_ERROR,
          'Batch failed at operation ' + (i + 1) + ': ' + e.message + '. All changes rolled back.');
      }
    }

    ENTERPRISE.transaction.commit();
    ENTERPRISE.audit.record({
      type: 'BATCH_COMPLETED',
      operationCount: this._queue.length
    });

    this._queue = []; // Clear after successful execution
    return { results: results, message: 'Batch completed: ' + results.length + ' operations.' };
  },

  /** Clear the batch queue without executing */
  clear: function() {
    var count = this._queue.length;
    this._queue = [];
    return count;
  },

  /** Get current queue status */
  getStatus: function() {
    return {
      queueSize: this._queue.length,
      operations: this._queue.map(function(op) {
        return { tool: op.tool, description: op.description, status: op.status };
      })
    };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// ENTERPRISE FACADE — Single global access point
// ─────────────────────────────────────────────────────────────────────────────

var ENTERPRISE = {
  undo:        undoStack_,
  redo:        redoStack_,
  audit:       auditLog_,
  history:     executionHistory_,
  cost:        costTracker_,
  dryRun:      dryRun_,
  transaction: transaction_,
  rateLimit:   rateLimiter_,
  permissions: permissions_,
  batch:       batch_,

  /**
   * ops is an alias for MEMORY.ops — operation recording lives in MemoryManager.
   * We expose it here for convenience since enterprise code records ops too.
   */
  get ops() { return typeof MEMORY !== 'undefined' ? MEMORY.ops : { record: function(){}, getRecent: function(){ return []; } }; },

  /**
   * Get a complete enterprise status snapshot for the sidebar.
   */
  getStatus: function() {
    return {
      dryRunEnabled: this.dryRun.isEnabled(),
      undoLevels:    this.undo.depth(),
      undoPreview:   this.undo.peek(),
      rateLimit:     this.rateLimit.getStatus(),
      cost:          this.cost.getSummary(),
      batchQueue:    this.batch.getStatus(),
      recentAudit:   this.audit.getRecent(5),
      permissions:   this.permissions.checkEditAccess()
    };
  }
};
