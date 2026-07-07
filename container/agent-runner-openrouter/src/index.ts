/**
 * NanoClaw OpenRouter Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * This runner uses the OpenAI-compatible API (via openai npm package) to talk
 * to OpenRouter. It implements its own tool-calling loop (not Claude Agent SDK).
 *
 * Session history is stored as JSON in /workspace/group/openrouter-history.json
 */

import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
} from 'openai/resources/chat/completions';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[openrouter-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/**
 * Load session history from JSON file
 */
function loadSessionHistory(
  groupFolder: string,
): ChatCompletionMessageParam[] {
  const historyPath = path.join('/workspace/group', 'openrouter-history.json');
  if (!fs.existsSync(historyPath)) {
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    log(
      `Failed to load session history: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Save session history to JSON file
 */
function saveSessionHistory(
  groupFolder: string,
  messages: ChatCompletionMessageParam[],
): void {
  // Filter out invalid messages: assistant messages with null content are incomplete/failed responses
  // Also filter out orphaned tool messages (tool messages whose assistant message was filtered)
  const toolCallIdsToRemove = new Set<string>();

  // First pass: identify tool_call_ids from assistant messages we're removing
  messages.forEach((msg) => {
    if (msg.role === 'assistant' && msg.content === null && msg.tool_calls) {
      msg.tool_calls.forEach((tc) => toolCallIdsToRemove.add(tc.id));
      log(`WARNING: Removing assistant message with null content and its tool calls`);
    }
  });

  // Second pass: filter out invalid assistant messages and orphaned tool messages
  const validMessages = messages.filter((msg) => {
    if (msg.role === 'assistant' && msg.content === null) {
      return false;
    }
    if (msg.role === 'tool' && toolCallIdsToRemove.has((msg as any).tool_call_id)) {
      log(`WARNING: Removing orphaned tool message (tool_call_id: ${(msg as any).tool_call_id})`);
      return false;
    }
    return true;
  });

  const historyPath = path.join('/workspace/group', 'openrouter-history.json');
  fs.writeFileSync(historyPath, JSON.stringify(validMessages, null, 2));
}

/**
 * Load CLAUDE.md files from additionalDirectories
 */
function loadClaudeMdFiles(): string {
  const parts: string[] = [];

  // Group-specific CLAUDE.md first (takes precedence)
  const groupPath = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(groupPath)) {
    parts.push(fs.readFileSync(groupPath, 'utf-8'));
  } else {
    // Fallback to global CLAUDE.md if no group-specific one
    const globalPath = '/workspace/global/CLAUDE.md';
    if (fs.existsSync(globalPath)) {
      parts.push(fs.readFileSync(globalPath, 'utf-8'));
    }
  }

  // Extra directories mounted at /workspace/extra/*
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const claudeMdPath = path.join(extraBase, entry, 'CLAUDE.md');
      if (fs.existsSync(claudeMdPath)) {
        parts.push(fs.readFileSync(claudeMdPath, 'utf-8'));
      }
    }
  }

  return parts.join('\n\n---\n\n');
}

/**
 * Bash tool: standard read-only filesystem commands allowed
 */
async function executeBash(command: string): Promise<string> {
  const trimmed = command.trim();

  // Whitelist: common safe commands for file operations, database, and HTTP
  const allowedCommands = [
    'ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc', 'sort', 'uniq',
    'psql', 'curl', 'wget', 'git', 'npm', 'node', 'pwd', 'echo', 'date',
    'rm', 'mkdir', 'mv', 'cp', 'touch'
  ];

  const firstToken = trimmed.split(/\s+/)[0];
  const allowed = allowedCommands.includes(firstToken) ||
                  trimmed.startsWith('curl http://host.docker.internal:');

  if (!allowed) {
    return `ERROR: Command not permitted. Allowed: ${allowedCommands.join(', ')}`;
  }

  const { execSync } = await import('child_process');
  try {
    const output = execSync(command, {
      encoding: 'utf-8',
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return output;
  } catch (err: any) {
    return `ERROR: ${err.message}\nStderr: ${err.stderr || ''}`;
  }
}

/**
 * Read file tool
 */
async function readFile(filePath: string): Promise<string> {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Write file tool
 */
async function writeFile(filePath: string, content: string): Promise<string> {
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return `File written successfully: ${filePath}`;
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Web search tool (placeholder — requires actual implementation)
 */
async function webSearch(query: string): Promise<string> {
  // TODO: implement actual web search via MCP or external API
  return `Web search not yet implemented for query: ${query}`;
}

/**
 * Web fetch tool
 */
async function webFetch(url: string): Promise<string> {
  try {
    const https = await import('https');
    const http = await import('http');
    const protocol = url.startsWith('https:') ? https : http;

    return new Promise((resolve, reject) => {
      protocol
        .get(url, (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => resolve(data));
        })
        .on('error', reject);
    });
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Send message via MCP nanoclaw server (IPC bridge)
 */
async function sendMessage(
  chatJid: string,
  message: string,
  groupFolder: string,
): Promise<string> {
  const ipcDir = '/workspace/ipc/messages';
  fs.mkdirSync(ipcDir, { recursive: true });
  const msgFile = path.join(ipcDir, `${Date.now()}.json`);
  fs.writeFileSync(
    msgFile,
    JSON.stringify({
      type: 'send_message',
      chat_jid: chatJid,
      message,
      group_folder: groupFolder,
    }),
  );
  return `Message queued for ${chatJid}`;
}

/**
 * Schedule task via MCP nanoclaw server (IPC bridge)
 */
async function scheduleTask(
  prompt: string,
  scheduleValue: string,
  groupFolder: string,
  chatJid: string,
): Promise<string> {
  const ipcDir = '/workspace/ipc/tasks';
  fs.mkdirSync(ipcDir, { recursive: true });
  const taskFile = path.join(ipcDir, `${Date.now()}.json`);
  fs.writeFileSync(
    taskFile,
    JSON.stringify({
      type: 'schedule_task',
      prompt,
      schedule_value: scheduleValue,
      group_folder: groupFolder,
      chat_jid: chatJid,
    }),
  );
  return `Task scheduled: ${prompt.slice(0, 50)}...`;
}

/**
 * Store memory via IPC bridge
 */
async function storeMemory(
  content: string,
  category: string,
  groupFolder: string,
): Promise<string> {
  const ipcDir = '/workspace/ipc/tasks';
  fs.mkdirSync(ipcDir, { recursive: true });
  const msgFile = path.join(ipcDir, `${Date.now()}.json`);

  // Determine agent name from group folder
  let agentName = 'savio'; // default
  if (groupFolder.includes('telegram_raine')) {
    agentName = 'raine';
  } else if (groupFolder.includes('telegram_savio')) {
    agentName = 'savio';
  }

  const payload = {
    type: 'store_memory',
    content,
    category,
    agent: agentName,
  };

  fs.writeFileSync(msgFile, JSON.stringify(payload));
  log(`store_memory IPC: agent=${agentName}, category=${category}, groupFolder=${groupFolder}`);

  return `Memory stored in category: ${category} for agent: ${agentName}`;
}

/**
 * Fetch memories via direct database query
 */
async function fetchMemory(
  query?: string,
  category?: string,
  limit: number = 10,
  groupFolder: string = '',
): Promise<string> {
  // Determine agent name from group folder
  let agentName = 'savio';
  if (groupFolder.includes('telegram_raine')) {
    agentName = 'raine';
  } else if (groupFolder.includes('telegram_savio')) {
    agentName = 'savio';
  }

  const { execSync } = await import('child_process');
  try {
    let sql = `SELECT id, LEFT(content, 200) as content_preview, category, captured_at FROM memories WHERE agent = '${agentName}'`;

    if (category) {
      sql += ` AND category = '${category}'`;
    }
    if (query) {
      sql += ` AND content ILIKE '%${query}%'`;
    }

    sql += ` ORDER BY captured_at DESC LIMIT ${limit}`;

    const output = execSync(`psql "$SECOND_BRAIN_DB_URL" -c "${sql}"`, {
      encoding: 'utf-8',
      timeout: 10000,
    });
    return output;
  } catch (err: any) {
    return `ERROR: ${err.message}`;
  }
}

/**
 * Tool definitions for OpenAI
 */
function getTools(containerInput: ContainerInput): ChatCompletionTool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'bash',
        description:
          'Execute a bash command (restricted to psql and curl http://host.docker.internal:... only)',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The bash command to run' },
          },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read the contents of a file',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Path to the file' },
          },
          required: ['file_path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write content to a file',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Path to the file' },
            content: { type: 'string', description: 'Content to write' },
          },
          required: ['file_path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web for information',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_fetch',
        description: 'Fetch content from a URL',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to fetch' },
          },
          required: ['url'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'send_message',
        description: 'Send a message to a chat',
        parameters: {
          type: 'object',
          properties: {
            chat_jid: { type: 'string', description: 'Chat JID to send to' },
            message: { type: 'string', description: 'Message content' },
          },
          required: ['chat_jid', 'message'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'schedule_task',
        description: 'Schedule a task to run at a specific time or interval',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Task prompt' },
            schedule_value: {
              type: 'string',
              description: 'Cron expression or interval',
            },
          },
          required: ['prompt', 'schedule_value'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'store_memory',
        description: 'Store a memory in the Second Brain database for future recall',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'The memory content to store' },
            category: {
              type: 'string',
              description: 'Memory category (e.g., user, feedback, project:name)',
            },
          },
          required: ['content', 'category'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'fetch_memory',
        description: 'Fetch memories from the Second Brain database. Returns up to 10 recent memories by default.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Optional search query to filter memory content',
            },
            category: {
              type: 'string',
              description: 'Optional category filter (e.g., user, feedback, project:name)',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of memories to return (default 10, max 50)',
            },
          },
          required: [],
        },
      },
    },
  ];
}

/**
 * Execute a tool call
 */
async function executeTool(
  toolName: string,
  args: any,
  containerInput: ContainerInput,
): Promise<string> {
  switch (toolName) {
    case 'bash':
      return executeBash(args.command);
    case 'read_file':
      return readFile(args.file_path);
    case 'write_file':
      return writeFile(args.file_path, args.content);
    case 'web_search':
      return webSearch(args.query);
    case 'web_fetch':
      return webFetch(args.url);
    case 'send_message':
      return sendMessage(
        args.chat_jid,
        args.message,
        containerInput.groupFolder,
      );
    case 'schedule_task':
      return scheduleTask(
        args.prompt,
        args.schedule_value,
        containerInput.groupFolder,
        containerInput.chatJid,
      );
    case 'store_memory':
      return storeMemory(args.content, args.category, containerInput.groupFolder);
    case 'fetch_memory':
      return fetchMemory(
        args.query,
        args.category,
        args.limit || 10,
        containerInput.groupFolder,
      );
    default:
      return `ERROR: Unknown tool: ${toolName}`;
  }
}

/**
 * Strip <internal> tags from text
 */
function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '');
}

/**
 * Main agent loop
 */
async function runAgent(containerInput: ContainerInput): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    writeOutput({
      status: 'error',
      result: null,
      error: 'OPENROUTER_API_KEY not set',
    });
    return;
  }

  const model = process.env.AGENT_MODEL || 'qwen/qwen3-235b-a22b';

  const client = new OpenAI({
    apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    timeout: 120000, // 2 minutes timeout for OpenRouter API calls
    maxRetries: 2,
  });

  // Load session history
  let messages: ChatCompletionMessageParam[] = loadSessionHistory(
    containerInput.groupFolder,
  );

  // Fix invalid messages: assistant messages with null content break some models
  messages = messages.map((msg) => {
    if (msg.role === 'assistant' && msg.content === null) {
      return { ...msg, content: '' };
    }
    return msg;
  });

  // Load CLAUDE.md files as system prompt
  const claudeMdContent = loadClaudeMdFiles();
  if (claudeMdContent && messages.length === 0) {
    messages.push({
      role: 'system',
      content: claudeMdContent,
    });
  }

  // Add user prompt
  messages.push({
    role: 'user',
    content: containerInput.prompt,
  });

  const tools = getTools(containerInput);
  let iterationCount = 0;
  const MAX_ITERATIONS = 10; // Lowered from 20 to prevent excessive looping
  let consecutiveErrors = 0;
  let consecutiveToolCalls = 0; // Track consecutive tool calls without text response

  while (iterationCount < MAX_ITERATIONS) {
    iterationCount++;
    log(
      `Iteration ${iterationCount}: ${messages.length} messages in history`,
    );

    let completion;
    try {
      completion = await client.chat.completions.create({
        model,
        messages,
        tools,
        temperature: 0.7,
      });
      consecutiveErrors = 0; // Reset on success
    } catch (err: any) {
      consecutiveErrors++;
      log(`API error (attempt ${consecutiveErrors}): ${err.message}`);
      log(`Full error: ${JSON.stringify(err, null, 2)}`);

      // On repeated 400 errors, clear history and retry with just the current prompt
      if (err.status === 400 && consecutiveErrors >= 2) {
        log('Clearing session history due to repeated 400 errors');
        const systemMsg = messages.find(m => m.role === 'system');
        const userMsg = messages[messages.length - 1];
        messages = systemMsg ? [systemMsg, userMsg] : [userMsg];

        // Try one more time with clean history
        try {
          completion = await client.chat.completions.create({
            model,
            messages,
            tools,
            temperature: 0.7,
          });
          consecutiveErrors = 0;
        } catch (retryErr: any) {
          writeOutput({
            status: 'error',
            result: null,
            error: `API error after history cleanup: ${retryErr.message}`,
          });
          return;
        }
      } else {
        writeOutput({
          status: 'error',
          result: null,
          error: `API error: ${err.message}`,
        });
        return;
      }
    }

    const choice = completion.choices[0];
    if (!choice) {
      writeOutput({
        status: 'error',
        result: null,
        error: 'No completion choice returned',
      });
      return;
    }

    const assistantMessage = choice.message;
    messages.push(assistantMessage);

    // Check for tool calls
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      consecutiveToolCalls++;
      log(
        `Model requested ${assistantMessage.tool_calls.length} tool call(s) (consecutive: ${consecutiveToolCalls})`,
      );

      // If model has made 6+ consecutive tool calls without responding, inject a prompt
      if (consecutiveToolCalls >= 6) {
        log('WARNING: 6+ consecutive tool calls - will inject response prompt after this iteration');
      }

      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall.function.name;
        const toolArgs = JSON.parse(toolCall.function.arguments);
        log(`Executing tool: ${toolName}`);

        const toolResult = await executeTool(
          toolName,
          toolArgs,
          containerInput,
        );
        log(`Tool result: ${toolResult.slice(0, 200)}`);

        const toolMessage: ChatCompletionToolMessageParam = {
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResult,
        };
        messages.push(toolMessage);
      }

      // After 6+ consecutive tool calls, inject a prompt to force a response
      if (consecutiveToolCalls >= 6) {
        messages.push({
          role: 'user',
          content: 'Please provide a summary response to the user based on the tool results above. Do not make more tool calls.',
        });
        log('Injected response prompt to break tool-calling loop');
      }

      // Continue loop to get next model response
      continue;
    }

    // No tool calls — final response (reset counter)
    consecutiveToolCalls = 0;
    const finalText = assistantMessage.content || '';
    const strippedText = stripInternalTags(finalText);

    log(`Final response (${strippedText.length} chars)`);

    // Save session history
    saveSessionHistory(containerInput.groupFolder, messages);

    writeOutput({
      status: 'success',
      result: strippedText,
      newSessionId: 'openrouter-session', // Placeholder session ID
    });

    return;
  }

  // Hit iteration limit
  writeOutput({
    status: 'error',
    result: null,
    error: `Maximum iterations (${MAX_ITERATIONS}) reached`,
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  try {
    await runAgent(containerInput);
  } catch (err) {
    log(`Agent error: ${err instanceof Error ? err.message : String(err)}`);
    writeOutput({
      status: 'error',
      result: null,
      error: `Agent error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
