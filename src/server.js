/**
 * GitExplorer backend proxy.
 *
 * Purpose: the Flutter app calls THIS server instead of calling GitHub/Groq
 * directly. This server holds the real GitHub PAT and Groq API key as
 * environment variables (never shipped inside the app binary) and forwards
 * requests. Every route below makes a real outbound call — nothing here is
 * mocked or faked.
 *
 * Deploy for free on Render.com or Railway.app (steps in backend README).
 */

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const GITHUB_TOKEN = process.env.GITHUB_PAT;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PORT = process.env.PORT || 3000;

if (!GITHUB_TOKEN) {
  console.warn('WARNING: GITHUB_PAT not set. GitHub requests will run unauthenticated (60 req/hr shared across ALL app users).');
}
if (!GROQ_API_KEY) {
  console.warn('WARNING: GROQ_API_KEY not set. /ai/summarize will fail until this is set.');
}

// Protect your own shared quota from abuse — this limits each device/IP,
// not the total GitHub quota, which is separately protected by GitHub itself.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

/**
 * Generic GitHub REST proxy. The app sends the GitHub API path (e.g.
 * "/search/repositories?q=flutter") and this forwards it to
 * https://api.github.com with the real server-side token attached.
 */
app.get('/github/*', async (req, res) => {
  const githubPath = req.params[0];
  const queryString = req.originalUrl.split('?')[1];
  const url = `https://api.github.com/${githubPath}${queryString ? '?' + queryString : ''}`;

  try {
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'GitExplorer-App',
        'Accept-Encoding': 'identity',
        ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
        // Some GitHub endpoints (README raw content, star timestamps) need
        // a specific Accept header the client sends through as a custom
        // header so we forward it faithfully.
        ...(req.headers['x-forward-accept'] ? { Accept: req.headers['x-forward-accept'] } : {}),
      },
    });

    const contentType = response.headers.get('content-type') || '';
    res.status(response.status);

    // Forward real rate-limit headers back to the app so its UI can still
    // show live usage — this is YOUR server's GitHub quota now, shared
    // across all app users, which is exactly why the limiter above exists.
    ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'].forEach((h) => {
      const v = response.headers.get(h);
      if (v) res.setHeader(h, v);
    });

    if (contentType.includes('application/json')) {
      const data = await response.json();
      res.json(data);
    } else {
      const text = await response.text();
      res.send(text);
    }
  } catch (err) {
    res.status(502).json({ message: 'Upstream GitHub request failed', error: err.message });
  }
});

/**
 * AI summarizer proxy — forwards to Groq's real chat completions endpoint
 * with the server-side key, so the app never holds a Groq key at all.
 */
app.post('/ai/summarize', async (req, res) => {
  if (!GROQ_API_KEY) {
    return res.status(503).json({ message: 'AI summaries are not configured on this server yet.' });
  }

  const { repoFullName, description, readme, primaryLanguage, topics } = req.body;
  const truncatedReadme = (readme || '').length > 6000
    ? readme.slice(0, 6000) + '\n...(truncated)'
    : (readme || 'No README available.');

  const prompt = `Summarize this GitHub repository for a developer deciding whether to use it.

Repo: ${repoFullName}
Description: ${description || 'None provided'}
Primary language: ${primaryLanguage || 'Unknown'}
Topics: ${(topics && topics.length) ? topics.join(', ') : 'None'}

README content:
${truncatedReadme}

Respond with:
1. A 2-3 sentence plain-English summary of what this project does
2. Who it's for / typical use case
3. Getting started difficulty (Easy/Moderate/Advanced) with a one-line reason

Keep the whole response under 150 words. No markdown headers, just plain short paragraphs.`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
        'Connection': 'close',
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 400,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ message: data.error?.message || 'Groq request failed' });
    }
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return res.status(502).json({ message: 'Empty response from Groq' });
    }
    res.json({ summary: content.trim() });
  } catch (err) {
    res.status(502).json({ message: 'Upstream Groq request failed', error: err.message });
  }
});

app.post('/ai/analyze-user', async (req, res) => {
  if (!GROQ_API_KEY) {
    return res.status(503).json({ message: 'AI summaries are not configured on this server yet.' });
  }

  const { username, bio, repos } = req.body;
  const repoDetails = (repos || []).slice(0, 8).map(r => `- ${r.name} (${r.language || 'Mixed'}): ${r.description || 'No description'}`).join('\n');

  const prompt = `You are an expert technical recruiter analyzing a GitHub developer's profile.
Analyze this developer based on their bio and top repositories.

Username: ${username}
Bio: ${bio || 'None provided'}
Top Repositories:
${repoDetails || 'No public repositories'}

Respond with:
1. A 2-sentence summary of their "Developer Vibe" (e.g., "Open-source contributor specializing in mobile apps. Strong focus on UI/UX.").
2. Their top 2-3 inferred technical skills based on the repo languages and descriptions.

Keep the entire response under 100 words. No markdown headers, just plain short text.`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
        'Connection': 'close',
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
        max_tokens: 300,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ message: data.error?.message || 'Groq request failed' });
    }
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return res.status(502).json({ message: 'Empty response from Groq' });
    }
    res.json({ analysis: content.trim() });
  } catch (err) {
    res.status(502).json({ message: 'Upstream Groq request failed', error: err.message });
  }
});

app.post('/ai/explain-code', async (req, res) => {
  if (!GROQ_API_KEY) {
    return res.status(503).json({ message: 'AI summaries are not configured on this server yet.' });
  }

  const { filename, code } = req.body;
  if (!code || !filename) {
    return res.status(400).json({ message: 'Filename and code are required.' });
  }

  // Truncate code if it's too long for the AI token limits (max ~8k tokens for llama-3.1-8b)
  const safeCode = code.length > 15000 ? code.substring(0, 15000) + '\n...[TRUNCATED]' : code;

  const prompt = `You are a senior software engineer mentoring a junior developer.
Please explain the purpose and functionality of the following file: \`${filename}\`.

CODE:
\`\`\`
${safeCode}
\`\`\`

Explain exactly what this file does, how it works, and highlight any interesting patterns or important functions. 
Keep it concise, clear, and easy to read. Use markdown for code snippets. Limit response to 250 words max.`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
        'Connection': 'close',
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 500,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ message: data.error?.message || 'Groq request failed' });
    }
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return res.status(502).json({ message: 'Empty response from Groq' });
    }
    res.json({ explanation: content.trim() });
  } catch (err) {
    res.status(502).json({ message: 'Upstream Groq request failed', error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`GitExplorer backend proxy listening on port ${PORT}`);
});
