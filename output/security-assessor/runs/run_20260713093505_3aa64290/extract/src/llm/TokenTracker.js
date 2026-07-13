/**
 * TokenTracker - Extracts and normalizes token usage from LLM responses.
 * Handles different response formats from various LLM providers.
 */
class TokenTracker {
  /**
   * Extract token usage from an LLM response and normalize it.
   */
  static extractUsage(
    response,
    provider,
    model,
    userInstructionLength = '',
    status = 'success',
    errorMessage = '',
    correlationID = '',
    tokenCategory = 'General'
  ) {
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;

    if (response && response.usage) {
      // OpenAI / Groq / OpenRouter compatible format
      promptTokens     = response.usage.prompt_tokens     || 0;
      completionTokens = response.usage.completion_tokens || 0;
      totalTokens      = response.usage.total_tokens      || (promptTokens + completionTokens);
    }

    return {
      promptTokens:          promptTokens.toString(),
      completionTokens:      completionTokens.toString(),
      totalTokens:           totalTokens.toString(),
      userInstructionLength: userInstructionLength.toString(),
      status,
      errorMessage:  TokenTracker.sanitizeErrorMessage(errorMessage),
      correlationID: correlationID  || '',
      tokenCategory: tokenCategory  || 'General',
    };
  }

  /**
   * Sanitize an error message so it is safe for a single CSV cell.
   *
   * LLM SDKs (Gemini, Anthropic, OpenRouter …) embed the raw HTTP body in
   * error.message, which often contains:
   *   • Real newline characters  →  break multi-line CSV quoted fields
   *   • Deeply-nested JSON blobs →  bloat the file and confuse parsers
   *
   * Strategy
   * ─────────
   * 1. Extract a human-readable summary from the JSON blob when possible.
   * 2. Otherwise collapse all whitespace / newlines to a single space.
   * 3. Hard-cap the result at 300 characters so the cell stays readable.
   *
   * @param {string|Error|*} raw  - The raw error message / object
   * @returns {string}            - Safe single-line string, max 300 chars
   */
  static sanitizeErrorMessage(raw) {
    if (!raw) return '';

    // Accept Error objects
    let str = (raw instanceof Error) ? raw.message : String(raw);

    // ── Try to extract a concise summary from embedded JSON ─────────────────
    // Pattern: "Provider error: STATUS_CODE {…json…}"
    // e.g.  "Gemini error: 429 { \"error\": { \"code\": 429, \"message\": \"…\", … } }"
    const jsonStart = str.indexOf('{');
    if (jsonStart !== -1) {
      const prefix  = str.slice(0, jsonStart).trim();   // e.g. "Gemini error: 429"
      const jsonStr = str.slice(jsonStart);

      try {
        // Collapse whitespace before parsing so JSON.parse works on the
        // multi-line body that SDKs embed raw
        const parsed = JSON.parse(jsonStr.replace(/[\r\n]+/g, ' '));

        // Pull the most useful human-readable field out of common error shapes
        const msg =
          parsed?.error?.message ||          // Gemini / Google style
          parsed?.error?.error?.message ||   // nested
          parsed?.message ||                 // flat
          parsed?.error ||                   // plain string field
          null;

        if (msg && typeof msg === 'string') {
          // Trim the inner message too (Gemini pads with quota details)
          const shortMsg = msg
            .replace(/[\r\n]+/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim()
            .slice(0, 200);
          str = prefix ? `${prefix} — ${shortMsg}` : shortMsg;
        } else {
          // JSON parsed but no message field; use prefix + code
          const code = parsed?.error?.code || parsed?.code || '';
          str = prefix + (code ? ` (${code})` : '');
        }
      } catch (_) {
        // JSON.parse failed — fall through to generic collapse below
        str = prefix + ' [parse error in response body]';
      }
    }

    // ── Final normalisation ─────────────────────────────────────────────────
    str = str
      .replace(/[\r\n\t]+/g, ' ')   // collapse all line-breaks and tabs
      .replace(/\s{2,}/g, ' ')      // collapse runs of spaces
      .trim()
      .slice(0, 300);               // hard cap

    return str;
  }

  /**
   * Generate an IST timestamp string: "YYYY-MM-DD HH:MM:SS IST"
   */
  static getISTTimestamp() {
    const now     = new Date();
    const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));

    const pad = (n) => String(n).padStart(2, '0');
    return (
      `${istTime.getFullYear()}-${pad(istTime.getMonth() + 1)}-${pad(istTime.getDate())} ` +
      `${pad(istTime.getHours())}:${pad(istTime.getMinutes())}:${pad(istTime.getSeconds())} IST`
    );
  }

  /**
   * Escape a single value for CSV output (RFC-4180 compliant).
   *
   * Note: errorMessage values should already have been sanitized by
   * sanitizeErrorMessage() so they are single-line. This method still
   * handles quotes and commas as a safety net.
   *
   * @param {*} field
   * @returns {string}
   */
  static escapeCSVField(field) {
    if (field === null || field === undefined) return '';

    const str = String(field);

    // Wrap in double-quotes if the value contains commas, quotes, or
    // (defensively) any remaining newlines.
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }

    return str;
  }

  /**
   * Format a usage data object as a CSV row string (no trailing newline).
   */
  static formatAsCSVRow(data) {
    const {
      timestamp,
      correlationID       = '',
      provider,
      model,
      tokenCategory       = 'General',
      promptTokens,
      completionTokens,
      totalTokens,
      userInstructionLength,
      status,
      errorMessage,
    } = data;

    const fields = [
      timestamp,
      correlationID,
      provider,
      model,
      tokenCategory,
      promptTokens,
      completionTokens,
      totalTokens,
      userInstructionLength,
      status,
      errorMessage,
    ].map(TokenTracker.escapeCSVField);

    return fields.join(',');
  }

  /**
   * Return the CSV header row string.
   */
  static getCSVHeader() {
    return 'Timestamp (IST),Correlation_ID,LLM_Provider,Model_Name,Token_Category,' +
           'Prompt_Tokens,Completion_Tokens,Total_Tokens,User_Instruction_Length,Status,Error_Message';
  }
}

export default TokenTracker;
