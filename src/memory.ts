/**
 * Second Brain memory layer.
 * Reads context from Postgres before each agent run.
 * Stores memories with local Ollama embeddings after each run.
 *
 * Fully non-fatal: if Postgres or Ollama are unavailable,
 * Andy continues working without memory context.
 */
import pg from 'pg';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const envConfig = readEnvFile(['SECOND_BRAIN_DB_URL', 'OLLAMA_URL']);

const DB_URL = process.env.SECOND_BRAIN_DB_URL || envConfig.SECOND_BRAIN_DB_URL;
const OLLAMA_URL =
  process.env.OLLAMA_URL || envConfig.OLLAMA_URL || 'http://localhost:11434';
const EMBED_MODEL = 'nomic-embed-text';
const EXTRACT_MODEL = 'llama3.2:3b';

let pool: pg.Pool | null = null;

function getPool(): pg.Pool | null {
  if (!DB_URL) return null;
  if (!pool) {
    pool = new pg.Pool({
      connectionString: DB_URL,
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 3000,
    });
    pool.on('error', (err) => {
      logger.warn({ err }, 'Postgres pool error (memory layer)');
    });
  }
  return pool;
}

export function initMemoryDb(): void {
  const p = getPool();
  if (!p) {
    logger.info('SECOND_BRAIN_DB_URL not set — memory layer disabled');
    return;
  }
  p.query('SELECT 1')
    .then(() => logger.info('Second Brain Postgres connected'))
    .catch((err) =>
      logger.warn(
        { err },
        'Second Brain Postgres not reachable — continuing without memory',
      ),
    );
}

/**
 * Fetch memory context to inject before each agent run.
 * Returns a markdown string, or empty string if unavailable.
 */
export async function fetchMemoryContext(): Promise<string> {
  const p = getPool();
  if (!p) return '';

  try {
    const [profile, projects, memories, messages] = await Promise.all([
      p.query<{ key: string; value: string }>(
        'SELECT key, value FROM user_profile ORDER BY key',
      ),
      p.query<{
        id: string;
        name: string;
        description: string | null;
        notes: string | null;
      }>(
        "SELECT id, name, description, notes FROM projects WHERE status = 'active' ORDER BY updated_at DESC LIMIT 10",
      ),
      p.query<{ content: string; captured_at: Date }>(
        'SELECT content, captured_at FROM memories ORDER BY captured_at DESC LIMIT 30',
      ),
      p.query<{
        id: string;
        from_agent: string;
        thread_id: string;
        subject: string | null;
        body: string;
        created_at: Date;
      }>(
        `SELECT id, from_agent, thread_id, subject, body, created_at
         FROM agent_messages
         WHERE (to_agent = 'andy' OR to_agent = 'all') AND status = 'unread'
         ORDER BY created_at ASC`,
      ),
    ]);

    const lines: string[] = ['<second_brain_context>'];

    if (profile.rows.length > 0) {
      lines.push('## About Peter');
      for (const row of profile.rows) {
        lines.push(`- ${row.key}: ${row.value}`);
      }
      lines.push('');
    }

    if (projects.rows.length > 0) {
      lines.push('## Active Projects');
      for (const p of projects.rows) {
        lines.push(`**${p.name}** (${p.id})`);
        if (p.description) lines.push(`  ${p.description}`);
        if (p.notes) lines.push(`  Notes: ${p.notes}`);
      }
      lines.push('');
    }

    if (memories.rows.length > 0) {
      lines.push('## Memory');
      for (const m of memories.rows) {
        const date = new Date(m.captured_at).toLocaleDateString('en-AU');
        lines.push(`- [${date}] ${m.content}`);
      }
      lines.push('');
    }

    if (messages.rows.length > 0) {
      lines.push('## Messages from other agents');
      for (const m of messages.rows) {
        const date = new Date(m.created_at).toLocaleDateString('en-AU');
        const subject = m.subject ? ` — ${m.subject}` : '';
        lines.push(
          `**[${date}] From ${m.from_agent}${subject} (thread: ${m.thread_id})**`,
        );
        lines.push(m.body);
        lines.push('');
      }
      // Mark them read
      const ids = messages.rows.map((m) => m.id);
      p.query(
        `UPDATE agent_messages SET status = 'read', read_at = now() WHERE id = ANY($1)`,
        [ids],
      ).catch(() => {});
    }

    lines.push('</second_brain_context>');

    return lines.join('\n');
  } catch (err) {
    logger.warn({ err }, 'fetchMemoryContext failed — continuing without');
    return '';
  }
}

/**
 * Generate an embedding vector for text using Ollama (local, private).
 * Returns null if Ollama is unavailable.
 */
async function embedText(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: text }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { embeddings?: number[][] };
    return data.embeddings?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Store a memory in Postgres with a local Ollama embedding.
 * Non-fatal: silently skips if DB or Ollama unavailable.
 */
export async function storeMemory(
  content: string,
  sourceType: string = 'conversation',
  category?: string,
  thinkingTier?: 'build' | 'architecture' | 'speculation',
): Promise<void> {
  const p = getPool();
  if (!p) return;

  try {
    const sourceResult = await p.query<{ id: string }>(
      'INSERT INTO sources (type, title) VALUES ($1, $2) RETURNING id',
      [sourceType, `${sourceType} — ${new Date().toISOString()}`],
    );
    const sourceId = sourceResult.rows[0].id;

    const embedding = await embedText(content);
    const embeddingStr = embedding ? `[${embedding.join(',')}]` : null;

    await p.query(
      `INSERT INTO memories (source_id, content, embedding, category, thinking_tier)
       VALUES ($1, $2, $3, $4, $5)`,
      [sourceId, content, embeddingStr, category ?? null, thinkingTier ?? null],
    );

    logger.debug({ category, thinkingTier, contentLength: content.length }, 'Memory stored');
  } catch (err) {
    logger.warn({ err }, 'storeMemory failed — skipping');
  }
}

/**
 * Ask Ollama to extract key memories from a conversation, then store them.
 * Runs async after Andy responds — never delays the user.
 * Non-fatal: silently skips if Ollama or DB unavailable.
 */
export async function extractAndStoreMemories(
  conversation: string,
  sourceType: string = 'conversation',
  groupName?: string,
): Promise<void> {
  const p = getPool();
  if (!p) return;

  // Trim very long conversations to keep the prompt manageable
  const trimmed =
    conversation.length > 8000
      ? conversation.slice(0, 8000) + '\n[...truncated]'
      : conversation;

  const systemPrompt = `You extract long-term memories from conversations.
Return a JSON object with a memories array: {"memories": [{"content": "one clear sentence", "category": "decision|preference|project_note|personal|research"}]}.
Rules:
- 3 to 7 items maximum
- Only facts worth remembering weeks from now
- Skip greetings, small talk, transient errors, step-by-step troubleshooting
- Prefer decisions, preferences, project state, and personal context
- Each item must be self-contained and make sense without the conversation`;

  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: EXTRACT_MODEL,
        stream: false,
        format: 'json',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `CONVERSATION:\n${trimmed}` },
        ],
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) return;

    const data = (await res.json()) as { message?: { content?: string } };
    const raw = data.message?.content ?? '';

    let items: { content: string; category: string }[];
    try {
      const parsed = JSON.parse(raw);
      items = Array.isArray(parsed)
        ? parsed
        : (parsed.memories ?? parsed.items ?? []);
    } catch {
      logger.warn(
        { raw },
        'extractAndStoreMemories: failed to parse Ollama JSON',
      );
      return;
    }

    const sourceResult = await p.query<{ id: string }>(
      'INSERT INTO sources (type, title) VALUES ($1, $2) RETURNING id',
      [
        sourceType,
        groupName
          ? `${groupName} — ${new Date().toISOString()}`
          : new Date().toISOString(),
      ],
    );
    const sourceId = sourceResult.rows[0].id;

    for (const item of items) {
      if (!item.content || typeof item.content !== 'string') continue;
      const embedding = await embedText(item.content);
      const embeddingStr = embedding ? `[${embedding.join(',')}]` : null;
      await p.query(
        `INSERT INTO memories (source_id, content, embedding, category)
         VALUES ($1, $2, $3, $4)`,
        [sourceId, item.content.trim(), embeddingStr, item.category ?? null],
      );
    }

    logger.info(
      { count: items.length, sourceType, groupName },
      'Memories extracted and stored',
    );
  } catch (err) {
    logger.warn({ err }, 'extractAndStoreMemories failed — skipping');
  }
}

/**
 * Send a message from one agent to another (or broadcast to 'all').
 */
export async function sendAgentMessage(
  fromAgent: string,
  toAgent: string,
  threadId: string,
  body: string,
  subject?: string,
  priority?: string,
): Promise<void> {
  const p = getPool();
  if (!p) return;

  try {
    await p.query(
      `INSERT INTO agent_messages (from_agent, to_agent, thread_id, subject, body, priority)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [fromAgent, toAgent, threadId, subject ?? null, body, priority ?? null],
    );
    logger.debug({ fromAgent, toAgent, threadId }, 'Agent message sent');
  } catch (err) {
    logger.warn({ err }, 'sendAgentMessage failed — skipping');
  }
}

/**
 * Fetch unread messages for an agent (including broadcasts to 'all').
 * Marks them as read.
 */
export async function fetchUnreadMessages(
  agentName: string,
): Promise<
  Array<{
    id: string;
    from_agent: string;
    thread_id: string;
    subject: string | null;
    body: string;
    created_at: Date;
  }>
> {
  const p = getPool();
  if (!p) return [];

  try {
    const result = await p.query<{
      id: string;
      from_agent: string;
      thread_id: string;
      subject: string | null;
      body: string;
      created_at: Date;
    }>(
      `SELECT id, from_agent, thread_id, subject, body, created_at
       FROM agent_messages
       WHERE (to_agent = $1 OR to_agent = 'all')
         AND status = 'unread'
       ORDER BY created_at ASC`,
      [agentName],
    );

    if (result.rows.length > 0) {
      const ids = result.rows.map((r) => r.id);
      await p.query(
        `UPDATE agent_messages SET status = 'read', read_at = now()
         WHERE id = ANY($1)`,
        [ids],
      );
    }

    return result.rows;
  } catch (err) {
    logger.warn({ err }, 'fetchUnreadMessages failed — returning empty');
    return [];
  }
}

/**
 * Fetch a full message thread by thread_id.
 */
export async function fetchThread(
  threadId: string,
): Promise<
  Array<{
    from_agent: string;
    to_agent: string;
    body: string;
    status: string;
    created_at: Date;
  }>
> {
  const p = getPool();
  if (!p) return [];

  try {
    const result = await p.query<{
      from_agent: string;
      to_agent: string;
      body: string;
      status: string;
      created_at: Date;
    }>(
      `SELECT from_agent, to_agent, body, status, created_at
       FROM agent_messages
       WHERE thread_id = $1
       ORDER BY created_at ASC`,
      [threadId],
    );
    return result.rows;
  } catch (err) {
    logger.warn({ err }, 'fetchThread failed — returning empty');
    return [];
  }
}

/**
 * Mark a message as actioned.
 */
export async function markActioned(messageId: string): Promise<void> {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(
      `UPDATE agent_messages SET status = 'actioned' WHERE id = $1`,
      [messageId],
    );
  } catch (err) {
    logger.warn({ err }, 'markActioned failed — skipping');
  }
}

/**
 * Store a research finding in Postgres with a local Ollama embedding.
 * Non-fatal: silently skips if DB or Ollama unavailable.
 */
export async function storeResearch(
  topic: string,
  finding: string,
  source?: string,
  tags?: string[],
): Promise<void> {
  const p = getPool();
  if (!p) return;

  try {
    const embedding = await embedText(`${topic}: ${finding}`);
    const embeddingStr = embedding ? `[${embedding.join(',')}]` : null;

    await p.query(
      `INSERT INTO research_log (topic, finding, source, tags, embedding)
       VALUES ($1, $2, $3, $4, $5)`,
      [topic, finding, source ?? null, tags ?? null, embeddingStr],
    );

    logger.debug({ topic, findingLength: finding.length }, 'Research stored');
  } catch (err) {
    logger.warn({ err }, 'storeResearch failed — skipping');
  }
}

/**
 * Store or update a project in Postgres.
 */
export async function upsertProject(
  id: string,
  name: string,
  description?: string,
  notes?: string,
  status: string = 'active',
): Promise<void> {
  const p = getPool();
  if (!p) return;

  try {
    await p.query(
      `INSERT INTO projects (id, name, description, notes, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name,
             description = COALESCE(EXCLUDED.description, projects.description),
             notes = COALESCE(EXCLUDED.notes, projects.notes),
             status = EXCLUDED.status,
             updated_at = now()`,
      [id, name, description ?? null, notes ?? null, status],
    );
    logger.debug({ id, name }, 'Project upserted');
  } catch (err) {
    logger.warn({ err }, 'upsertProject failed — skipping');
  }
}
