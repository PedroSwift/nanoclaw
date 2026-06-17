import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn:
    | ((groupJid: string, folder?: string) => Promise<boolean>)
    | null = null;
  private shuttingDown = false;

  /**
   * Generate composite key for multi-bot support: chatJid:folder
   * For backward compatibility, if folder is missing, uses chatJid alone.
   */
  private makeKey(groupJid: string, folder?: string): string {
    return folder ? `${groupJid}:${folder}` : groupJid;
  }

  private getGroup(groupJid: string, folder?: string): GroupState {
    const key = this.makeKey(groupJid, folder);
    let state = this.groups.get(key);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: folder || null,
        retryCount: 0,
      };
      this.groups.set(key, state);
    }
    return state;
  }

  setProcessMessagesFn(
    fn: (groupJid: string, folder?: string) => Promise<boolean>,
  ): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(groupJid: string, folder?: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid, folder);
    const key = this.makeKey(groupJid, folder);

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ groupJid, folder }, 'Container active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(key)) {
        this.waitingGroups.push(key);
      }
      logger.debug(
        { groupJid, folder, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(groupJid, folder, 'messages').catch((err) =>
      logger.error({ groupJid, folder, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(
    groupJid: string,
    taskId: string,
    fn: () => Promise<void>,
    folder?: string,
  ): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid, folder);

    // Prevent double-queuing: check both pending and currently-running task
    if (state.runningTaskId === taskId) {
      logger.debug(
        { groupJid, folder, taskId },
        'Task already running, skipping',
      );
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug(
        { groupJid, folder, taskId },
        'Task already queued, skipping',
      );
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (state.idleWaiting) {
        this.closeStdin(groupJid, folder);
      }
      logger.debug(
        { groupJid, folder, taskId },
        'Container active, task queued',
      );
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      const key = this.makeKey(groupJid, folder);
      if (!this.waitingGroups.includes(key)) {
        this.waitingGroups.push(key);
      }
      logger.debug(
        { groupJid, folder, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(groupJid, { id: taskId, groupJid, fn }, folder).catch((err) =>
      logger.error(
        { groupJid, folder, taskId, err },
        'Unhandled error in runTask',
      ),
    );
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
  ): void {
    const state = this.getGroup(groupJid, groupFolder);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   */
  notifyIdle(groupJid: string, folder?: string): void {
    const state = this.getGroup(groupJid, folder);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupJid, folder);
    }
  }

  /**
   * Returns true if a message container is active and can receive piped input.
   * Used to decide whether to fetch unread agent_messages before piping.
   */
  hasActiveMsgContainer(groupJid: string, folder?: string): boolean {
    const key = this.makeKey(groupJid, folder);
    const state = this.groups.get(key);
    return !!(
      state &&
      state.active &&
      state.groupFolder &&
      !state.isTaskContainer
    );
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(groupJid: string, text: string, folder?: string): boolean {
    const state = this.getGroup(groupJid, folder);
    if (!state.active || !state.groupFolder || state.isTaskContainer)
      return false;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string, folder?: string): void {
    const state = this.getGroup(groupJid, folder);
    if (!state.active || !state.groupFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  private async runForGroup(
    groupJid: string,
    folder: string | undefined,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid, folder);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    this.activeCount++;

    logger.debug(
      { groupJid, folder, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid, folder);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, folder, state);
        }
      }
    } catch (err) {
      logger.error(
        { groupJid, folder, err },
        'Error processing messages for group',
      );
      this.scheduleRetry(groupJid, folder, state);
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(groupJid, folder);
    }
  }

  private async runTask(
    groupJid: string,
    task: QueuedTask,
    folder?: string,
  ): Promise<void> {
    const state = this.getGroup(groupJid, folder);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeCount++;

    logger.debug(
      { groupJid, folder, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error(
        { groupJid, folder, taskId: task.id, err },
        'Error running task',
      );
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(groupJid, folder);
    }
  }

  private scheduleRetry(
    groupJid: string,
    folder: string | undefined,
    state: GroupState,
  ): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, folder, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, folder, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid, folder);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string, folder?: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid, folder);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task, folder).catch((err) =>
        logger.error(
          { groupJid, folder, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForGroup(groupJid, folder, 'drain').catch((err) =>
        logger.error(
          { groupJid, folder, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
      return;
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextKey = this.waitingGroups.shift()!;
      // Parse composite key: "jid:folder" or just "jid"
      const [groupJid, folder] = nextKey.includes(':')
        ? (nextKey.split(':', 2) as [string, string])
        : ([nextKey, undefined] as [string, undefined]);
      const state = this.getGroup(groupJid, folder);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(groupJid, task, folder).catch((err) =>
          logger.error(
            { groupJid, folder, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(groupJid, folder, 'drain').catch((err) =>
          logger.error(
            { groupJid, folder, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      }
      // If neither pending, skip this group
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Count active containers but don't kill them — they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    // This prevents WhatsApp reconnection restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const [jid, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
