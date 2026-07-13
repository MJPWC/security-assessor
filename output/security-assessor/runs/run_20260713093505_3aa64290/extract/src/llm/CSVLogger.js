import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import TokenTracker from './TokenTracker.js';
import { redactSensitiveText } from '../security/redaction.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Module-level write queue keyed by resolved file path.
// Multiple CSVLogger instances targeting the same file share one queue so
// concurrent agents don't interleave partial lines in the CSV.
const _writeQueues = new Map(); // filePath -> Promise (tail of queue)

function _enqueue(filePath, work) {
  const tail = (_writeQueues.get(filePath) || Promise.resolve()).then(work).catch(() => {});
  _writeQueues.set(filePath, tail);
  return tail;
}

/**
 * CSVLogger - Handles CSV file operations for token usage logging.
 * Multiple instances sharing the same file path are safe to use concurrently
 * because writes are serialised through a per-path promise queue.
 */
class CSVLogger {
  constructor(filePath = null) {
    if (!filePath) {
      // Default path: output/llm_token_usage.csv (relative to project root)
      const projectRoot = path.join(__dirname, '..', '..');
      this.filePath = path.join(projectRoot, 'output', 'llm_token_usage.csv');
    } else {
      this.filePath = path.resolve(filePath); // normalise so paths compare correctly
    }

    this.ensureDirectoryExists();
    this.ensureHeaderExists();
  }

  /**
   * Ensure the output directory exists
   */
  ensureDirectoryExists() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Ensure the CSV file has headers
   */
  ensureHeaderExists() {
    if (!fs.existsSync(this.filePath)) {
      const header = TokenTracker.getCSVHeader();
      try {
        fs.writeFileSync(this.filePath, header + '\n', { encoding: 'utf8' });
        console.log(`📄 Created token usage CSV file: ${this.filePath}`);
      } catch (error) {
        console.error(`❌ Failed to create CSV file: ${error.message}`);
      }
    }
  }

  /**
   * Append a row to the CSV file.
   * Writes are serialised through a per-path queue so concurrent agents
   * targeting the same file never interleave partial lines.
   * @param {object} data - Data object with usage information
   */
  appendRow(data) {
    const row = TokenTracker.formatAsCSVRow(data);
    _enqueue(this.filePath, () => {
      try {
        fs.appendFileSync(this.filePath, row + '\n', { encoding: 'utf8' });
      } catch (error) {
        console.error(`❌ Failed to append to CSV: ${error.message}`);
      }
    });
  }

  /**
   * Log a token usage entry
   * @param {string} provider - LLM provider
   * @param {string} model - Model name
   * @param {object} response - LLM response object
   * @param {number} userInstructionLength - Length of user instruction
   * @param {string} status - Request status (success or error)
   * @param {string} errorMessage - Error message if applicable
   * @param {string} correlationID - Unique correlation ID for tracking
   * @param {string} tokenCategory - Category of token usage (General, Architecture, etc.)
   */
  logUsage(provider, model, response, userInstructionLength = 0, status = 'success', errorMessage = '', correlationID = '', tokenCategory = 'General') {
    const timestamp = TokenTracker.getISTTimestamp();
    const safeErrorMessage = redactSensitiveText(errorMessage);
    const usage = TokenTracker.extractUsage(response, provider, model, userInstructionLength, status, safeErrorMessage, correlationID, tokenCategory);
    
    const data = {
      timestamp,
      correlationID,
      provider,
      model,
      tokenCategory,
      ...usage
    };

    this.appendRow(data);
  }

  /**
   * Get the file path
   * @returns {string} Path to the CSV file
   */
  getFilePath() {
    return this.filePath;
  }

  /**
   * Get the number of rows in the CSV file (excluding header)
   * @returns {number} Number of data rows
   */
  getRowCount() {
    try {
      if (!fs.existsSync(this.filePath)) {
        return 0;
      }
      const content = fs.readFileSync(this.filePath, 'utf8');
      const lines = content.split('\n').filter(line => line.trim().length > 0);
      return Math.max(0, lines.length - 1); // Subtract 1 for header
    } catch (error) {
      console.error(`❌ Failed to get row count: ${error.message}`);
      return 0;
    }
  }

  /**
   * Read the CSV file and return all rows
   * @returns {array} Array of data rows (strings)
   */
  readRows() {
    try {
      if (!fs.existsSync(this.filePath)) {
        return [];
      }
      const content = fs.readFileSync(this.filePath, 'utf8');
      const lines = content.split('\n').filter(line => line.trim().length > 0);
      // Return all lines except header
      return lines.slice(1);
    } catch (error) {
      console.error(`❌ Failed to read CSV: ${error.message}`);
      return [];
    }
  }
}

export default CSVLogger;
