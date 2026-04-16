'use strict';

/**
 * Fix Agent — Self-Healing Loop
 *
 * Reads the critique JSON produced by ai-review.js, calls Claude to generate
 * surgical find-and-replace patches for every critical/high finding, and
 * applies them to the files on disk.  The workflow then commits and pushes
 * the changes with FIX_AGENT_PAT so the push re-triggers ai-review.yml,
 * creating the review → fix → re-review loop.
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY — Anthropic key
 *   GITHUB_TOKEN      — for GitHub API (read PR files, post comments)
 *   CRITIQUE_FILE    — path to critique.json (default: critique.json)
 *   REPO_OWNER       — e.g. "taroserigano777"
 *   REPO_NAME        — e.g. "test-agentic-workflo___2"
 *   PR_NUMBER        — pull request number
 *   FIX_ITERATION    — 0-based count of fix commits already on this branch
 */

const https = require('https');
const fs = require('fs');

const CLAUDE_MODEL = 'claude-sonnet-4-6'; // high quality fixes
const MAX_FILE_CHARS = 4000; // per file, to keep prompts lean

// --------------- Claude (Anthropic) helper ---------------

function callClaude(systemPrompt, userPrompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 3000,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' }, // cache static system prompt across retries
        },
      ],
      messages: [
        { role: 'user', content: userPrompt },
      ],
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Claude API HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
        }
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed.content[0].text.trim());
        } catch (e) {
          reject(new Error(`Failed to parse Claude response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// --------------- GitHub helper ---------------

function githubAPI(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: urlPath,
      method,
      headers: {
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'fix-agent',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    };

    if (body) {
      const payload = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function postComment(comment) {
  const { REPO_OWNER, REPO_NAME, PR_NUMBER } = process.env;
  return githubAPI(
    'POST',
    `/repos/${REPO_OWNER}/${REPO_NAME}/issues/${PR_NUMBER}/comments`,
    { body: comment }
  );
}

// --------------- Fix agent prompt ---------------

const FIX_SYSTEM_PROMPT = `You are a senior software engineer applying targeted code fixes.

You will receive:
1. Current content of files touched by the PR
2. A list of critical/high severity findings from a code review

Your task: generate surgical find-and-replace patches that fix each finding.

Output EXACTLY a JSON array — no markdown fences, no extra text:
[
  {
    "file": "relative/path/to/file.js",
    "original": "exact verbatim substring to replace (must be unique within the file)",
    "replacement": "corrected code"
  }
]

Rules:
- "original" must appear verbatim in the file — copy it precisely, including whitespace
- Each patch must be minimal — change only what is needed to fix the finding
- Skip findings that cannot be fixed with a simple substitution (architectural issues, etc.)
- If nothing needs fixing, output an empty array: []`;

// --------------- Main ---------------

async function main() {
  const { REPO_OWNER, REPO_NAME, PR_NUMBER } = process.env;
  const fixIteration = parseInt(process.env.FIX_ITERATION || '0', 10) + 1;
  const critiqueFile = process.env.CRITIQUE_FILE || 'critique.json';

  console.log(`\n=== Fix Agent — Iteration ${fixIteration} ===\n`);

  // 1. Load critique
  if (!fs.existsSync(critiqueFile)) {
    console.log('No critique.json found — nothing to fix.');
    process.exit(0);
  }

  const critique = JSON.parse(fs.readFileSync(critiqueFile, 'utf8'));
  const actionable = (critique.findings || []).filter(
    (f) => f.severity === 'critical' || f.severity === 'high'
  );

  if (actionable.length === 0) {
    console.log(`Verdict: ${critique.verdict} — no critical/high findings. Skipping fix.`);
    process.exit(0);
  }

  console.log(`${actionable.length} critical/high finding(s) to address:`);
  actionable.forEach((f, i) => console.log(`  ${i + 1}. [${f.severity}] ${f.description}`));

  // 2. Collect current content of PR-touched files
  const prFiles = await githubAPI(
    'GET',
    `/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${PR_NUMBER}/files`
  );

  const fileContents = {};
  if (Array.isArray(prFiles)) {
    for (const f of prFiles) {
      if (fs.existsSync(f.filename)) {
        fileContents[f.filename] = fs.readFileSync(f.filename, 'utf8').slice(0, MAX_FILE_CHARS);
      }
    }
  }

  if (Object.keys(fileContents).length === 0) {
    console.log('Could not read any PR files on disk.');
    await postComment(`🤖 **Fix Agent (Iteration ${fixIteration}):** Could not read PR files. Manual review required.`);
    process.exit(0);
  }

  const fileContext = Object.entries(fileContents)
    .map(([file, content]) => `### ${file}\n\`\`\`\n${content}\n\`\`\``)
    .join('\n\n');

  const findingsList = actionable
    .map((f, i) => `${i + 1}. [${f.severity}] (${f.agent}): ${f.description}`)
    .join('\n');

  // 3. Ask Claude for patches
  console.log('\nCalling Claude for fix patches...');
  const rawPatches = await callClaude(
    FIX_SYSTEM_PROMPT,
    `## Files\n${fileContext}\n\n## Findings to Fix\n${findingsList}`
  );

  let patches;
  try {
    // Strip accidental markdown fences if model misbehaves
    const cleaned = rawPatches.replace(/^```[a-z]*\n?/m, '').replace(/```$/m, '').trim();
    patches = JSON.parse(cleaned);
  } catch {
    console.error('Fix Agent returned invalid JSON:\n', rawPatches);
    await postComment(
      `🤖 **Fix Agent (Iteration ${fixIteration}):** Could not parse fix output. Manual review required.\n\n<details><summary>Raw output</summary>\n\n\`\`\`\n${rawPatches}\n\`\`\`\n\n</details>`
    );
    process.exit(0);
  }

  if (!Array.isArray(patches) || patches.length === 0) {
    console.log('Fix Agent produced no patches.');
    await postComment(
      `🤖 **Fix Agent (Iteration ${fixIteration}):** No auto-fixable patches generated for the ${actionable.length} finding(s). Manual review required.`
    );
    process.exit(0);
  }

  // 4. Apply patches
  const applied = [];
  const failed = [];

  for (const patch of patches) {
    const { file, original, replacement } = patch;

    if (!file || original === undefined || replacement === undefined) {
      failed.push({ file: file || '?', reason: 'malformed patch (missing fields)' });
      continue;
    }
    if (!fs.existsSync(file)) {
      failed.push({ file, reason: 'file not found on disk' });
      continue;
    }

    let content = fs.readFileSync(file, 'utf8');
    if (!content.includes(original)) {
      failed.push({ file, reason: 'original string not found in file' });
      continue;
    }

    // Apply only the first occurrence to avoid unintended double-patches
    content = content.replace(original, replacement);
    fs.writeFileSync(file, content, 'utf8');
    applied.push(file);
    console.log(`  ✓ Patched: ${file}`);
  }

  // 5. Report results as PR comment
  if (applied.length === 0) {
    const reasons = failed.map((f) => `- \`${f.file}\`: ${f.reason}`).join('\n');
    await postComment(
      `🤖 **Fix Agent (Iteration ${fixIteration}):** Patches generated but none could be applied.\n\n${reasons}`
    );
    console.log('No patches applied.');
    process.exit(0);
  }

  const fixedList = applied.map((f) => `- \`${f}\``).join('\n');
  const failNote = failed.length > 0
    ? `\n\n⚠️ **Could not auto-fix (${failed.length}):**\n${failed.map((f) => `- \`${f.file}\`: ${f.reason}`).join('\n')}`
    : '';

  const comment = [
    `## 🔧 Fix Agent — Iteration ${fixIteration}`,
    '',
    `Applied automatic fixes to **${applied.length}** file(s) for ${actionable.length} critical/high finding(s):`,
    '',
    fixedList,
    failNote,
    '',
    '> 🔄 Re-running AI review on the updated code…',
  ].join('\n');

  await postComment(comment);
  console.log(`\nFix Agent done. Patched ${applied.length} file(s).`);
}

main().catch((err) => {
  console.error('Fix Agent error:', err.message);
  process.exit(1);
});
