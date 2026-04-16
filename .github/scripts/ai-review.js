'use strict';

/**
 * Multi-Agent AI PR Review Pipeline
 * Agents: Reviewer, Editor, Security → Critique (synthesizer)
 * Uses Anthropic Claude (claude-sonnet-4-6) with prompt caching
 *
 * Environment variables required:
 *   ANTHROPIC_API_KEY, GITHUB_TOKEN, PR_DIFF, PR_TITLE, PR_BODY, PR_NUMBER, REPO_OWNER, REPO_NAME
 *   REVIEW_MODE: "observer" | "suggest" | "auto"
 */

const https = require('https');
const fs = require('fs');

// --------------- Config ---------------

const CLAUDE_MODEL = 'claude-sonnet-4-6'; // high quality reviews
const MAX_DIFF_CHARS = 12000; // keep token usage reasonable
const CONFIDENCE_THRESHOLD = 90;
const MAX_LINES_FOR_AUTO = 200;

const REVIEW_MODE = process.env.REVIEW_MODE || 'observer';

// --------------- Claude (Anthropic) helper ---------------
// System prompts are sent with cache_control so repeated runs hit the prompt cache,
// reducing latency and cost on every PR re-run.

function callClaude(systemPrompt, userPrompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1500,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' }, // cache static system prompts
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

    req.setTimeout(30000, () => {
      req.destroy(new Error('Claude API request timed out after 30s'));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// --------------- GitHub helpers ---------------

function githubAPI(method, path, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'ai-review-agent',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          console.error(`GitHub API ${method} ${path} → HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
        }
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          resolve({});
        }
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

// --------------- Agent prompts ---------------

const REVIEWER_PROMPT = `You are a senior code reviewer. Analyze the PR diff for:
- Logic bugs or incorrect behavior
- Edge cases not handled
- Performance issues
- Missing error handling at boundaries

Be specific. Reference line numbers from the diff when possible.
Output format:
## Findings
- (list each finding with severity: critical / warning / nit)

If nothing found, say "No issues found."`;

const EDITOR_PROMPT = `You are a code editor focused on code quality. Analyze the PR diff for:
- Code readability improvements
- Better naming or structure
- Unnecessary complexity
- Idiomatic improvements for the language used

Only suggest changes that meaningfully improve the code. Skip trivial style nits.
Output format:
## Suggestions
- (list each suggestion with impact: high / medium / low)

If nothing to suggest, say "Code looks clean."`;

const SECURITY_PROMPT = `You are a security engineer. Analyze the PR diff for:
- OWASP Top 10 vulnerabilities
- Hardcoded secrets or credentials
- Injection risks (SQL, command, path traversal)
- Insecure dependencies or patterns
- Information leakage

Be precise and avoid false positives. Only flag genuine risks.
Output format:
## Security Findings
- (list each finding with severity: critical / high / medium / low)

If nothing found, say "No security issues detected."`;

function buildCritiquePrompt(reviewerOutput, editorOutput, securityOutput) {
  return `You are a lead engineering manager reviewing the outputs of three AI review agents.

## Reviewer Agent Output:
${reviewerOutput}

## Editor Agent Output:
${editorOutput}

## Security Agent Output:
${securityOutput}

Your job:
1. Remove duplicate or contradictory findings
2. Filter out false positives or noise
3. Rank remaining findings by severity
4. Decide a verdict: PASS, WARN, or FAIL
   - PASS: No blocking issues, safe to merge
   - WARN: Has non-blocking suggestions worth noting
   - FAIL: Has critical issues that must be fixed
5. Assign a confidence score (0-100)

Output EXACTLY this JSON (no markdown fences, no extra text):
{
  "verdict": "PASS|WARN|FAIL",
  "confidence": <number>,
  "summary": "<one paragraph overall assessment>",
  "findings": [
    {"severity": "critical|high|medium|low|nit", "agent": "reviewer|editor|security", "description": "<finding>"}
  ]
}`;
}

// --------------- Main pipeline ---------------

async function main() {
  // Read diff from file (avoids shell env size limits) or fall back to env var
  const diffFile = process.env.PR_DIFF_FILE;
  let rawDiff = '';
  if (diffFile && fs.existsSync(diffFile)) {
    rawDiff = fs.readFileSync(diffFile, 'utf8');
  } else {
    rawDiff = process.env.PR_DIFF || '';
  }

  if (!rawDiff.trim()) {
    console.error('No diff available — cannot run AI review.');
    process.exit(1);
  }

  if (rawDiff.length > MAX_DIFF_CHARS) {
    console.log(`WARNING: Diff is ${rawDiff.length} chars, truncating to ${MAX_DIFF_CHARS}. Findings beyond this point will be missed.`);
  }
  const diff = rawDiff.slice(0, MAX_DIFF_CHARS);

  const prTitle = process.env.PR_TITLE || '';
  const prBody = process.env.PR_BODY || '';
  const prNumber = process.env.PR_NUMBER;
  const linesChanged = parseInt(process.env.LINES_CHANGED || '0', 10);

  const userContext = `# PR: ${prTitle}\n\n${prBody}\n\n# Diff:\n\`\`\`\n${diff}\n\`\`\``;

  console.log('Running 3 agents in parallel...');

  // Parallel agent calls
  const [reviewerOutput, editorOutput, securityOutput] = await Promise.all([
    callClaude(REVIEWER_PROMPT, userContext),
    callClaude(EDITOR_PROMPT, userContext),
    callClaude(SECURITY_PROMPT, userContext),
  ]);

  console.log('Reviewer done. Editor done. Security done.');
  console.log('Running Critique Agent...');

  // Sequential critique
  const critiqueRaw = await callClaude(
    'You are a precise JSON output machine. Follow instructions exactly.',
    buildCritiquePrompt(reviewerOutput, editorOutput, securityOutput)
  );

  let critique;
  try {
    const cleaned = critiqueRaw.replace(/^```[a-z]*\n?/m, '').replace(/```$/m, '').trim();
    critique = JSON.parse(cleaned);
  } catch {
    console.error('Critique Agent returned invalid JSON, falling back to WARN.');
    critique = {
      verdict: 'WARN',
      confidence: 50,
      summary: 'Critique Agent output could not be parsed. Manual review recommended.',
      findings: [],
    };
  }

  // Persist critique for the fix-agent to consume as a workflow artifact
  fs.writeFileSync('critique.json', JSON.stringify(critique, null, 2));

  // --------------- Build PR comment ---------------

  const verdictEmoji = { PASS: '✅', WARN: '⚠️', FAIL: '🚫' };
  const modeLabel = { observer: '👁️ Observer', suggest: '💡 Suggest', auto: '🤖 Auto' };

  const findingsTable = critique.findings.length > 0
    ? critique.findings
        .map((f) => `| \`${f.severity}\` | ${f.agent} | ${f.description} |`)
        .join('\n')
    : '| — | — | No findings |';

  const autoMergeEligible =
    critique.verdict === 'PASS' &&
    critique.confidence >= CONFIDENCE_THRESHOLD &&
    linesChanged <= MAX_LINES_FOR_AUTO;

  let mergeAction = '';
  if (REVIEW_MODE === 'auto' && autoMergeEligible) {
    mergeAction = '🟢 **Auto-merge triggered** — waiting for human approval gate.';
  } else if (REVIEW_MODE === 'suggest' && autoMergeEligible) {
    mergeAction = '💡 **Suggestion:** This PR is safe to merge. Approve when ready.';
  } else if (critique.verdict === 'PASS') {
    mergeAction = '✅ AI review passed. Awaiting human approval.';
  } else {
    mergeAction = '🔒 **Merge blocked by AI review.** Please address findings above.';
  }

  const comment = [
    `## ${verdictEmoji[critique.verdict] || '❓'} AI Review Summary`,
    '',
    `**Verdict:** ${critique.verdict} | **Confidence:** ${critique.confidence}% | **Mode:** ${modeLabel[REVIEW_MODE] || REVIEW_MODE}`,
    '',
    `> ${critique.summary}`,
    '',
    '### Findings',
    '| Severity | Agent | Description |',
    '|----------|-------|-------------|',
    findingsTable,
    '',
    '<details>',
    '<summary>📋 Raw Agent Outputs (click to expand)</summary>',
    '',
    '#### 🔍 Reviewer Agent',
    reviewerOutput,
    '',
    '#### ✏️ Editor Agent',
    editorOutput,
    '',
    '#### 🔒 Security Agent',
    securityOutput,
    '',
    '</details>',
    '',
    '---',
    mergeAction,
    '',
    `> _AI Review by 4 agents (${CLAUDE_MODEL}) • ${new Date().toISOString()}_`,
  ].join('\n');

  console.log('Posting comment to PR...');
  await postComment(comment);
  console.log('Comment posted.');

  // --------------- Output for workflow ---------------

  // Write outputs for the workflow to read
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `verdict=${critique.verdict}\n`);
    fs.appendFileSync(outputFile, `confidence=${critique.confidence}\n`);
    fs.appendFileSync(outputFile, `auto_merge_eligible=${autoMergeEligible}\n`);
  }

  console.log(`Verdict: ${critique.verdict} | Confidence: ${critique.confidence}% | Auto-merge eligible: ${autoMergeEligible}`);
}

main().catch((err) => {
  console.error('AI Review failed:', err.message);
  // Write safe defaults so downstream jobs don't get undefined outputs
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, 'verdict=FAIL\n');
    fs.appendFileSync(outputFile, 'confidence=0\n');
    fs.appendFileSync(outputFile, 'auto_merge_eligible=false\n');
  }
  process.exit(1);
});
