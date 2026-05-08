import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import {
  extractAndStoreMemories,
  fetchMemoryContext,
  fetchUnreadMessages,
  hasUnreadWakeSignal,
  initMemoryDb,
  sendAgentMessage,
} from './memory.js';
import {
  classifyMessage,
  queryDeepseek,
  Destination,
} from './deepseek-router.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

/**
 * Check whether the message starts with an explicit recipient prefix.
 * Supports: "Andy: ...", "CC: ...", "CCode: ...", "Deepseek: ..."
 * Returns the destination and the stripped message text, or null if no prefix.
 */
function detectExplicitAddress(
  text: string,
): { destination: Destination; content: string } | null {
  const match = text.match(/^(andy|cc|ccode|deepseek)\s*:\s*/i);
  if (!match) return null;
  const prefix = match[1].toLowerCase();
  const content = text.slice(match[0].length).trim();
  if (prefix === 'andy') return { destination: 'andy', content };
  if (prefix === 'deepseek') return { destination: 'deepseek', content };
  return { destination: 'claude_code', content }; // cc / ccode
}

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
// Tracks the latest timestamp of messages piped to an active container.
// Cursor is NOT advanced at pipe time — only when the container actually produces output.
// If the container exits without responding, the cursor stays behind so the next
// processGroupMessages run picks up the unresponded messages.
let pendingPipedTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
let wakeCheckRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  // --- Routing: classify the latest user message and redirect if needed ---
  const latestUserMsg = missedMessages.filter((m) => !m.is_from_me).at(-1);
  if (latestUserMsg) {
    // Explicit address prefix bypasses LLM router (recovery path mirrors main loop)
    const explicit = detectExplicitAddress(latestUserMsg.content);
    const destination =
      explicit?.destination ?? (await classifyMessage(latestUserMsg.content));
    const contentToRoute = explicit?.content ?? latestUserMsg.content;

    if (destination !== 'andy') {
      // Advance cursor — message was handled by a non-Andy destination
      lastAgentTimestamp[chatJid] =
        missedMessages[missedMessages.length - 1].timestamp;
      saveState();
      logger.info({ group: group.name, destination }, 'Message routed');

      if (destination === 'deepseek') {
        await channel.setTyping?.(chatJid, true);
        try {
          const reply = await queryDeepseek(contentToRoute);
          await channel.sendMessage(chatJid, reply);
        } catch (err) {
          logger.error({ err }, 'Deepseek query failed');
          await channel.sendMessage(
            chatJid,
            'Deepseek unavailable — try again shortly.',
          );
        } finally {
          await channel.setTyping?.(chatJid, false);
        }
      } else if (destination === 'claude_code') {
        await sendAgentMessage(
          'andy',
          'claude_code',
          'task-routing',
          contentToRoute,
          'Task from Peter',
          'wake',
        );
        await channel.sendMessage(chatJid, '\u2192 Queued for CC');
      }
      return true;
    }
  }
  // destination === 'andy': fall through to container dispatch below
  // -----------------------------------------------------------------

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;
  const responseParts: string[] = [];

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
        responseParts.push(text);
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  // Advance cursor for piped messages only on clean container exit — not
  // eagerly in the streaming callback, where an output for the *previous*
  // message would falsely advance the cursor past a piped message that the
  // container hasn't processed yet, causing it to be silently dropped.
  if (output !== 'error' && !hadError && pendingPipedTimestamp[chatJid]) {
    lastAgentTimestamp[chatJid] = pendingPipedTimestamp[chatJid];
    delete pendingPipedTimestamp[chatJid];
    saveState();
  }

  // Safety net: if the container exited with error while a piped message was
  // in-flight, pendingPipedTimestamp is still set. Re-enqueue so those
  // messages are processed in the next container run.
  if (pendingPipedTimestamp[chatJid]) {
    logger.info(
      { group: group.name },
      'Container exited with unprocessed piped messages — re-queuing immediately',
    );
    delete pendingPipedTimestamp[chatJid];
    queue.enqueueMessageCheck(chatJid);
  }

  // Fire-and-forget: extract key memories from this conversation after responding
  if (output !== 'error' && !hadError && responseParts.length > 0) {
    const fullConversation = `USER:\n${prompt}\n\nANDY:\n${responseParts.join('\n')}`;
    extractAndStoreMemories(fullConversation, 'conversation', group.name).catch(
      () => {},
    );
  }

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Inject Second Brain memory context before the conversation prompt
  const memoryContext = await fetchMemoryContext();

  // Inject project-context.md from the group folder if present
  let projectContext = '';
  try {
    const groupDir = resolveGroupFolderPath(group.folder);
    const contextFile = path.join(groupDir, 'project-context.md');
    if (fs.existsSync(contextFile)) {
      const content = fs.readFileSync(contextFile, 'utf8').trim();
      if (content) {
        projectContext = `<project_context>\n${content}\n</project_context>`;
      }
    }
  } catch {
    // non-fatal
  }

  const contextParts = [memoryContext, projectContext, prompt].filter(Boolean);
  const promptWithMemory =
    contextParts.length > 1 ? contextParts.join('\n\n') : prompt;

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: promptWithMemory,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

/**
 * Check for unread wake-priority agent_messages addressed to Andy.
 * If any exist and Andy has no active container, launch one with the
 * messages as the prompt so Andy can process them without needing a
 * Telegram trigger.
 */
async function checkWakeSignals(): Promise<void> {
  if (wakeCheckRunning) return;

  const mainEntry = Object.entries(registeredGroups).find(([, g]) => g.isMain);
  if (!mainEntry) return;

  const [mainJid, mainGroup] = mainEntry;
  if (queue.hasActiveMsgContainer(mainJid)) return;

  if (!(await hasUnreadWakeSignal('andy'))) return;

  const unread = await fetchUnreadMessages('andy');
  if (unread.length === 0) return;

  const msgBlock = unread
    .map((m) => {
      const date = new Date(m.created_at).toLocaleDateString('en-AU');
      const subject = m.subject ? ` — ${m.subject}` : '';
      return `**[${date}] From ${m.from_agent}${subject} (thread: ${m.thread_id})**\n${m.body}`;
    })
    .join('\n\n');

  const prompt = `<agent_messages>\n${msgBlock}\n</agent_messages>`;

  logger.info({ count: unread.length }, 'Wake signal: launching Andy for unread agent messages');

  wakeCheckRunning = true;
  const channel = findChannel(channels, mainJid);
  await channel?.setTyping?.(mainJid, true);

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      queue.closeStdin(mainJid);
    }, IDLE_TIMEOUT);
  };

  try {
    await runAgent(mainGroup, prompt, mainJid, async (result) => {
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        if (text && channel) await channel.sendMessage(mainJid, text);
        resetIdleTimer();
      }
      if (result.status === 'success') queue.notifyIdle(mainJid);
    });
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    await channel?.setTyping?.(mainJid, false);
    wakeCheckRunning = false;
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;

          // --- Upstream routing: classify before queue/pipe decision ---
          // Must run here so mid-conversation messages are intercepted even
          // when Andy's container is already active.
          const latestUserMsg = messagesToSend
            .filter((m) => !m.is_from_me)
            .at(-1);
          if (latestUserMsg) {
            // Explicit address prefix ("Andy: ...", "CC: ...", "Deepseek: ...")
            // bypasses the LLM router entirely — destination is unambiguous.
            const explicit = detectExplicitAddress(latestUserMsg.content);
            const destination =
              explicit?.destination ??
              (await classifyMessage(latestUserMsg.content));
            const contentToRoute = explicit?.content ?? latestUserMsg.content;

            if (explicit) {
              logger.info(
                {
                  prefix: explicit.destination,
                  text: contentToRoute.substring(0, 60),
                },
                '[ROUTER] explicit address',
              );
            } else {
              logger.info(
                { text: latestUserMsg.content.substring(0, 60) },
                '[ROUTER] classifying',
              );
            }

            if (destination !== 'andy') {
              lastAgentTimestamp[chatJid] =
                messagesToSend[messagesToSend.length - 1].timestamp;
              saveState();
              logger.info({ group: group.name, destination }, 'Message routed');

              if (destination === 'deepseek') {
                channel
                  .setTyping?.(chatJid, true)
                  ?.catch((err) =>
                    logger.warn(
                      { chatJid, err },
                      'Failed to set typing indicator',
                    ),
                  );
                try {
                  const reply = await queryDeepseek(contentToRoute);
                  await channel.sendMessage(chatJid, reply);
                } catch (err) {
                  logger.error({ err }, 'Deepseek query failed');
                  await channel.sendMessage(
                    chatJid,
                    'Deepseek unavailable — try again shortly.',
                  );
                } finally {
                  channel
                    .setTyping?.(chatJid, false)
                    ?.catch((err) =>
                      logger.warn(
                        { chatJid, err },
                        'Failed to clear typing indicator',
                      ),
                    );
                }
              } else if (destination === 'claude_code') {
                await sendAgentMessage(
                  'andy',
                  'claude_code',
                  'task-routing',
                  contentToRoute,
                  'Task from Peter',
                  'wake',
                );
                await channel.sendMessage(chatJid, '\u2192 Queued for CC');
              }
              continue;
            }
          }
          // destination === 'andy': fall through to queue/pipe dispatch
          // ---------------------------------------------------------------

          const formatted = formatMessages(messagesToSend, TIMEZONE);

          // If a container is already active, inject any unread agent_messages
          // mid-session — they'd otherwise only appear at next session start.
          let formattedToSend = formatted;
          if (queue.hasActiveMsgContainer(chatJid)) {
            const unread = await fetchUnreadMessages('andy');
            if (unread.length > 0) {
              const msgBlock = unread
                .map((m) => {
                  const date = new Date(m.created_at).toLocaleDateString(
                    'en-AU',
                  );
                  const subject = m.subject ? ` — ${m.subject}` : '';
                  return `**[${date}] From ${m.from_agent}${subject} (thread: ${m.thread_id})**\n${m.body}`;
                })
                .join('\n\n');
              formattedToSend = `<agent_messages>\n${msgBlock}\n</agent_messages>\n\n${formatted}`;
              logger.info(
                { chatJid, count: unread.length },
                'Injecting unread agent_messages into active container session',
              );
            }
          }

          if (queue.sendMessage(chatJid, formattedToSend)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            // Record the piped timestamp but do NOT advance lastAgentTimestamp yet.
            // Cursor advances only when the container actually produces output (in the
            // processGroupMessages streaming callback). If the container exits without
            // responding, the cursor stays behind so the next run picks up these messages.
            pendingPipedTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }

    // Wake poll: launch Andy if a wake-priority agent_message is waiting.
    // Fire-and-forget — must not block the message loop.
    checkWakeSignals().catch((err) =>
      logger.warn({ err }, 'Wake signal check failed'),
    );

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

async function ensureContainerSystemRunning(): Promise<void> {
  await ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  await ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  initMemoryDb();
  loadState();
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    sendVoice: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel?.sendVoice) {
        logger.warn({ jid }, 'Channel does not support sendVoice');
        return;
      }
      const { synthesizeSpeech } = await import('./image.js');
      const audioPath = await synthesizeSpeech(text);
      if (!audioPath) {
        logger.warn({ jid }, 'TTS synthesis failed — voice message not sent');
        return;
      }
      try {
        await channel.sendVoice(jid, audioPath);
      } finally {
        import('fs').then((fsm) => fsm.default.unlink(audioPath, () => {}));
      }
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests.
// NANOCLAW_MAIN=1 is set by the PM2 ecosystem config (PM2 sets process.argv[1] to
// ProcessContainerFork.js, so argv comparison would never match).
// The argv fallback handles direct `node dist/index.js` invocations.
const isDirectRun =
  !!process.env.NANOCLAW_MAIN ||
  (process.argv[1] &&
    path.resolve(fileURLToPath(import.meta.url)).toLowerCase() ===
      path.resolve(process.argv[1]).toLowerCase());

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
