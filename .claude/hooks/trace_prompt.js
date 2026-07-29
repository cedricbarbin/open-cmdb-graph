#!/usr/bin/env node
// Stop hook: appends one CSV row per completed prompt to prompt_trace.csv,
// next to this script. Columns: timestamp, session_id, prompt_first_100,
// duration_seconds, tokens_total, tokens_estimated.
//
// Reconstructs "the prompt" and its cost from the session transcript (JSONL)
// Claude Code already writes - the Stop hook payload itself only carries
// `transcript_path`, not prompt text or usage. Schema notes (verified
// against a real transcript, not assumed):
//   - each line is a JSON object with a `type` field; genuine top-level user
//     prompts have type "user", isMeta !== true, isSidechain !== true, and
//     `message.content` that's either a plain string or an array containing
//     a "text" block with no "tool_result" block (tool-result turns are
//     ALSO type "user" with array content, so this distinction matters).
//   - assistant turns (type "assistant") carry `message.usage` with
//     input_tokens/output_tokens/cache_creation_input_tokens/
//     cache_read_input_tokens - the real per-turn token counts, not an
//     estimate, whenever present.
//
// Never throws past its own try/catch and always exits 0 - a parsing hiccup
// here must not block Claude Code's normal Stop flow.

const fs = require('fs');
const path = require('path');

const CSV_PATH = path.join(__dirname, '../../prompt_trace.csv');
const CSV_HEADER = 'timestamp,session_id,prompt_first_100,duration_seconds,tokens_total,tokens_estimated\n';

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function readTranscriptEntries(transcriptPath) {
  const raw = fs.readFileSync(transcriptPath, 'utf8');
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip any malformed/truncated line rather than aborting the whole trace.
    }
  }
  return entries;
}

function contentBlockTypes(content) {
  if (!Array.isArray(content)) return [];
  return content.map((b) => b && b.type).filter(Boolean);
}

function isGenuineUserPrompt(entry) {
  if (entry.type !== 'user' || entry.isMeta === true || entry.isSidechain === true) return false;
  const content = entry.message && entry.message.content;
  if (typeof content === 'string') return true;
  const types = contentBlockTypes(content);
  return types.includes('text') && !types.includes('tool_result');
}

function extractPromptText(entry) {
  const content = entry.message.content;
  if (typeof content === 'string') return content;
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function extractAssistantText(entry) {
  const content = entry.message && entry.message.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function sumUsage(usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0)
    + (usage.output_tokens || 0)
    + (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0);
}

function csvField(value) {
  const s = String(value).replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  return `"${s.replace(/"/g, '""')}"`;
}

function appendRow(row) {
  if (!fs.existsSync(CSV_PATH)) fs.writeFileSync(CSV_PATH, CSV_HEADER);
  fs.appendFileSync(CSV_PATH, row.map(csvField).join(',') + '\n');
}

function main() {
  const stdin = readStdin();
  const input = stdin ? JSON.parse(stdin) : {};
  const transcriptPath = input.transcript_path;
  const sessionId = input.session_id || '';
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return;

  const entries = readTranscriptEntries(transcriptPath);

  let promptIndex = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (isGenuineUserPrompt(entries[i])) {
      promptIndex = i;
      break;
    }
  }
  if (promptIndex === -1) return;

  const promptEntry = entries[promptIndex];
  const promptText = extractPromptText(promptEntry);
  const startTime = new Date(promptEntry.timestamp).getTime();
  if (!promptText || Number.isNaN(startTime)) return;

  let tokensTotal = 0;
  let assistantChars = 0;
  for (let i = promptIndex + 1; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.type !== 'assistant') continue;
    const usage = entry.message && entry.message.usage;
    if (usage) {
      tokensTotal += sumUsage(usage);
    } else {
      assistantChars += extractAssistantText(entry).length;
    }
  }

  let estimated = false;
  if (tokensTotal === 0) {
    // No usage block found anywhere (unexpected transcript shape) - fall
    // back to a rough ~4-chars-per-token estimate over what text we have.
    estimated = true;
    tokensTotal = Math.round((promptText.length + assistantChars) / 4);
  }

  const durationSeconds = Math.max(0, (Date.now() - startTime) / 1000);

  appendRow([
    new Date().toISOString(),
    sessionId,
    promptText.slice(0, 100),
    durationSeconds.toFixed(1),
    tokensTotal,
    estimated ? 'yes' : 'no'
  ]);
}

try {
  main();
} catch {
  // Swallow everything - see file header.
}
process.exit(0);
