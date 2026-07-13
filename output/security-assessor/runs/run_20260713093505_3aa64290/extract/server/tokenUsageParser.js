import fs from 'fs';
import path from 'path';

// ─── CSV line parser ──────────────────────────────────────────────────────────

/**
 * Split a *single logical CSV record* into fields, handling RFC-4180 quoting
 * (double-quote escaping, quoted fields that span newlines, etc.).
 *
 * @param {string} line  - One logical record (may contain embedded newlines
 *                         inside quoted fields if the caller has already
 *                         re-joined them).
 * @returns {string[]}
 */
function parseCSVLine(line) {
  const result = [];
  let current      = '';
  let insideQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch   = line[i];
    const next = line[i + 1];

    if (ch === '"') {
      if (insideQuotes && next === '"') {
        current += '"';   // escaped double-quote
        i++;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (ch === ',' && !insideQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }

  result.push(current.trim());
  return result;
}

// ─── Logical-record splitter ──────────────────────────────────────────────────

/**
 * Split raw CSV text into logical records, merging lines that fall inside a
 * quoted field (multi-line values).  This is the correct fix for the case
 * where an error message embedded in quotes spans multiple physical lines.
 *
 * The merged embedded newlines are replaced with a single space so the field
 * stays on one line after parsing — matching what sanitizeErrorMessage now
 * writes for new entries.
 *
 * @param {string} text  - Full file content
 * @returns {string[]}   - Array of logical record strings (header + data rows)
 */
function splitIntoLogicalRecords(text) {
  const physicalLines = text.split('\n');
  const records       = [];
  let   buffer        = '';
  let   openQuotes    = 0;

  for (const rawLine of physicalLines) {
    // Count unescaped double-quotes on this physical line
    let inEscape = false;
    for (let i = 0; i < rawLine.length; i++) {
      if (rawLine[i] === '"') {
        if (!inEscape) {
          openQuotes++;
          // peek ahead for escaped quote
          if (rawLine[i + 1] === '"') { inEscape = true; }
        } else {
          inEscape = false;   // second quote of an escaped pair
        }
      } else {
        inEscape = false;
      }
    }

    if (buffer === '') {
      buffer = rawLine;
    } else {
      // We are inside a quoted field — replace newline with space
      buffer += ' ' + rawLine.trimStart();
    }

    // If the running quote count is even, this physical line closes all quotes
    if (openQuotes % 2 === 0) {
      if (buffer.trim().length > 0) {
        records.push(buffer);
      }
      buffer     = '';
      openQuotes = 0;
    }
    // else: odd number of open quotes → keep accumulating into buffer
  }

  // Flush anything left (e.g. missing trailing newline)
  if (buffer.trim().length > 0) {
    records.push(buffer);
  }

  return records;
}

// ─── Canonical header ─────────────────────────────────────────────────────────

const CANONICAL_HEADER = [
  'Timestamp (IST)',
  'Correlation_ID',
  'LLM_Provider',
  'Model_Name',
  'Token_Category',
  'Prompt_Tokens',
  'Completion_Tokens',
  'Total_Tokens',
  'User_Instruction_Length',
  'Status',
  'Error_Message',
];

function empty(error) {
  return { entries: [], providers: [], totalRequests: 0, totalTokens: 0,
           hasNewFormat: false, newEntries: [], error };
}

// ─── Main parser ──────────────────────────────────────────────────────────────

/**
 * Parse the token usage CSV file and return normalized entries.
 *
 * Handles:
 *  • Multi-line quoted error fields (legacy bad data)
 *  • Old-format files without Correlation_ID / Token_Category columns
 *  • Missing / extra columns (tolerant row mapping)
 *
 * @returns {{ entries: object[], providers: string[], totalRequests: number,
 *             totalTokens: number, hasNewFormat: boolean, newEntries: object[],
 *             error?: string }}
 */
export function parseTokenUsageCSV() {
  try {
    const projectRoot = process.cwd();
    const csvPath     = path.join(projectRoot, 'output', 'llm_token_usage.csv');

    if (!fs.existsSync(csvPath)) {
      return empty('CSV file not found: ' + csvPath);
    }

    const fileContent = fs.readFileSync(csvPath, 'utf8');
    if (!fileContent.trim()) {
      return empty('CSV file is empty');
    }

    // ── Split into logical records (handles multi-line quoted fields) ────────
    const records = splitIntoLogicalRecords(fileContent);
    if (records.length === 0) return empty('No records found in CSV');

    // ── Detect header ────────────────────────────────────────────────────────
    const firstFields   = parseCSVLine(records[0]);
    const firstIsHeader = firstFields[0] && (
      firstFields[0].toLowerCase().includes('timestamp') ||
      firstFields[0].toLowerCase().includes('correlation') ||
      firstFields[0].toLowerCase().includes('time')
    );

    const headers        = firstIsHeader ? firstFields : CANONICAL_HEADER;
    const dataStartIndex = firstIsHeader ? 1 : 0;

    const hasNewFormat   = headers.includes('Correlation_ID');

    // ── Parse data rows ──────────────────────────────────────────────────────
    const entries    = [];
    const providers  = new Set();
    let   totalTokens = 0;
    const newEntries = [];

    for (let i = dataStartIndex; i < records.length; i++) {
      const fields = parseCSVLine(records[i]);
      if (fields.length === 0 || (fields.length === 1 && fields[0] === '')) continue;

      const entry = {};
      for (let j = 0; j < headers.length; j++) {
        entry[headers[j]] = (fields[j] !== undefined ? fields[j] : '');
      }

      // Defaults for columns added in later versions
      if (!entry['Token_Category']) entry['Token_Category'] = 'General';
      if (entry['Correlation_ID']  === undefined) entry['Correlation_ID'] = '';

      // Sanitize any remaining multi-line content in Error_Message
      // (covers legacy rows written before the fix)
      if (entry['Error_Message']) {
        entry['Error_Message'] = entry['Error_Message']
          .replace(/[\r\n]+/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim();
      }

      entries.push(entry);

      if (entry['Correlation_ID']) newEntries.push(entry);
      if (entry['LLM_Provider'])   providers.add(entry['LLM_Provider']);

      totalTokens += parseInt(entry['Total_Tokens']) || 0;
    }

    return {
      entries,
      providers:     Array.from(providers).sort(),
      totalRequests: entries.length,
      totalTokens,
      hasNewFormat,
      newEntries,
      formatInfo: {
        hasCorrelationID: hasNewFormat,
        hasTokenCategory: headers.includes('Token_Category'),
        format:           hasNewFormat ? 'new' : 'old',
      },
    };
  } catch (error) {
    console.error('Error parsing token usage CSV:', error);
    return empty(error.message);
  }
}

// ─── Statistics helper ────────────────────────────────────────────────────────

/**
 * Compute summary statistics from an array of raw CSV entry objects
 * (keyed by original CSV header names).
 *
 * @param {object[]} entries
 * @returns {object}
 */
export function getTokenStatistics(entries) {
  if (!entries || entries.length === 0) {
    return {
      totalRequests: 0, totalTokens: 0,
      totalPromptTokens: 0, totalCompletionTokens: 0,
      avgPromptTokens: 0, avgCompletionTokens: 0,
      successRate: 0, providerStats: {}, modelStats: {},
    };
  }

  const stats = {
    totalRequests:        entries.length,
    totalTokens:          0,
    totalPromptTokens:    0,
    totalCompletionTokens:0,
    successRequests:      0,
    providerStats:        {},
    modelStats:           {},
  };

  entries.forEach(entry => {
    const p = parseInt(entry['Prompt_Tokens'])     || 0;
    const c = parseInt(entry['Completion_Tokens']) || 0;

    stats.totalPromptTokens    += p;
    stats.totalCompletionTokens += c;
    stats.totalTokens          += p + c;

    if ((entry['Status'] || '').toLowerCase() === 'success') stats.successRequests++;

    const prov = entry['LLM_Provider'] || 'unknown';
    if (!stats.providerStats[prov]) stats.providerStats[prov] = { requests: 0, tokens: 0 };
    stats.providerStats[prov].requests++;
    stats.providerStats[prov].tokens += p + c;

    const mdl = entry['Model_Name'] || 'unknown';
    if (!stats.modelStats[mdl]) stats.modelStats[mdl] = { requests: 0, tokens: 0 };
    stats.modelStats[mdl].requests++;
    stats.modelStats[mdl].tokens += p + c;
  });

  stats.avgPromptTokens     = Math.round(stats.totalPromptTokens     / stats.totalRequests);
  stats.avgCompletionTokens = Math.round(stats.totalCompletionTokens / stats.totalRequests);
  stats.successRate         = Math.round((stats.successRequests       / stats.totalRequests) * 100);

  return stats;
}
