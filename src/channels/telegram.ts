import fs from 'fs';
import https from 'https';
import path from 'path';

import { Api, Bot, InputFile } from 'grammy';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { downloadPhoto, transcribeAudio } from '../image.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bots: Array<{ bot: Bot; folder: string | null; token: string }> = [];
  private opts: TelegramChannelOpts;
  private botToken: string;
  private extraBots: Array<{ token: string; folder: string }>;

  constructor(
    botToken: string,
    opts: TelegramChannelOpts,
    extraBots: Array<{ token: string; folder: string }> = [],
  ) {
    this.botToken = botToken;
    this.opts = opts;
    this.extraBots = extraBots;
  }

  private setupBot(
    bot: Bot,
    botToken: string,
    folderOverride: string | null,
  ): void {
    // Command to get chat ID (useful for registration)
    bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Determine which registered group to use:
      // If this bot has a folderOverride (multi-bot case), look up the group by folder
      // Otherwise, use the default group for this chatJid
      let group: RegisteredGroup | undefined;
      if (folderOverride) {
        // Multi-bot: import getRegisteredGroupsByJid to find the specific folder
        const { getRegisteredGroupsByJid } = await import('../db.js');
        const groupsForJid = getRegisteredGroupsByJid(chatJid);
        group = groupsForJid.find((g) => g.folder === folderOverride);
      } else {
        group = this.opts.registeredGroups()[chatJid];
      }

      if (!group) {
        logger.debug(
          { chatJid, chatName, folderOverride },
          'Message from unregistered Telegram chat or no matching folder',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName, folder: group.folder },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;

      let group: RegisteredGroup | undefined;
      if (folderOverride) {
        const allGroups = this.opts.registeredGroups();
        group = Object.values(allGroups).find(
          (g) => g.folder === folderOverride,
        );
      } else {
        group = this.opts.registeredGroups()[chatJid];
      }

      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;

      let group: RegisteredGroup | undefined;
      if (folderOverride) {
        const { getRegisteredGroupsByJid } = await import('../db.js');
        const groupsForJid = getRegisteredGroupsByJid(chatJid);
        group = groupsForJid.find((g) => g.folder === folderOverride);
      } else {
        group = this.opts.registeredGroups()[chatJid];
      }

      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const msgId = ctx.message.message_id.toString();
      const caption = ctx.message.caption ? `\n${ctx.message.caption}` : '';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      // Try to download the photo (largest size) into the group's images/ folder
      let content = `[Photo]${caption}`;
      try {
        const photos = ctx.message.photo;
        const largest = photos[photos.length - 1];
        const file = await ctx.api.getFile(largest.file_id);
        if (file.file_path) {
          const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
          const ext = path.extname(file.file_path) || '.jpg';
          const filename = `${msgId}${ext}`;
          const destPath = path.join(
            GROUPS_DIR,
            group.folder,
            'images',
            filename,
          );
          await downloadPhoto(fileUrl, destPath);
          content = `[Photo: images/${filename}]${caption}`;
          logger.info(
            { chatJid, filename },
            'Telegram photo saved to group workspace',
          );
        }
      } catch (err) {
        logger.warn(
          { err },
          'Failed to download Telegram photo — using placeholder',
        );
      }

      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });

    bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));

    bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;

      let group: RegisteredGroup | undefined;
      if (folderOverride) {
        const { getRegisteredGroupsByJid } = await import('../db.js');
        const groupsForJid = getRegisteredGroupsByJid(chatJid);
        group = groupsForJid.find((g) => g.folder === folderOverride);
      } else {
        group = this.opts.registeredGroups()[chatJid];
      }

      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const msgId = ctx.message.message_id.toString();
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      let content = '[Voice message]';
      try {
        const file = await ctx.api.getFile(ctx.message.voice.file_id);
        if (file.file_path) {
          const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
          const ext = path.extname(file.file_path) || '.oga';
          const filename = `voice-${msgId}${ext}`;
          const destPath = path.join(
            GROUPS_DIR,
            group.folder,
            'images',
            filename,
          );
          await downloadPhoto(fileUrl, destPath);
          const transcription = await transcribeAudio(destPath);
          if (transcription) {
            content = `[Voice message]: ${transcription}`;
            logger.info(
              { chatJid, duration: ctx.message.voice.duration },
              'Voice message transcribed',
            );
          } else {
            content = '[Voice message — transcription unavailable]';
          }
        }
      } catch (err) {
        logger.warn(
          { err },
          'Failed to transcribe voice message — using placeholder',
        );
      }

      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });

    bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });
  }

  async connect(): Promise<void> {
    // Create main bot
    const mainBot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    this.setupBot(mainBot, this.botToken, null);
    this.bots.push({ bot: mainBot, folder: null, token: this.botToken });

    // Create extra bots (for specific folders)
    for (const { token, folder } of this.extraBots) {
      const bot = new Bot(token, {
        client: {
          baseFetchConfig: { agent: https.globalAgent, compress: true },
        },
      });
      this.setupBot(bot, token, folder);
      this.bots.push({ bot, folder, token });
    }

    // Start all bots
    const startPromises = this.bots.map(
      ({ bot, folder }) =>
        new Promise<void>((resolve) => {
          bot.start({
            onStart: (botInfo) => {
              logger.info(
                { username: botInfo.username, id: botInfo.id, folder },
                'Telegram bot connected',
              );
              console.log(
                `\n  Telegram bot: @${botInfo.username}${folder ? ` (folder: ${folder})` : ''}`,
              );
              console.log(
                `  Send /chatid to the bot to get a chat's registration ID\n`,
              );
              resolve();
            },
          });
        }),
    );

    await Promise.all(startPromises);
  }

  async sendMessage(jid: string, text: string, folder?: string): Promise<void> {
    if (this.bots.length === 0) {
      logger.warn('Telegram bots not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Find the right bot: if folder is specified, use the bot for that folder
      let selectedBot = this.bots[0];
      if (folder) {
        const match = this.bots.find((b) => b.folder === folder);
        if (match) {
          selectedBot = match;
        } else {
          logger.warn(
            { folder, jid },
            'No bot found for folder, using main bot',
          );
        }
      }

      const { bot } = selectedBot;

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bots.length > 0;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    for (const { bot } of this.bots) {
      bot.stop();
    }
    this.bots = [];
    logger.info('Telegram bots stopped');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (this.bots.length === 0 || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      // Use first bot for typing indicator
      await this.bots[0].bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }

  async sendVoice(jid: string, audioPath: string): Promise<void> {
    if (this.bots.length === 0) {
      logger.warn('Telegram bots not initialized');
      return;
    }
    try {
      const numericId = jid.replace(/^tg:/, '');
      const stream = fs.createReadStream(audioPath);
      // Use first bot for sending voice
      await this.bots[0].bot.api.sendVoice(numericId, new InputFile(stream));
      logger.info({ jid, audioPath }, 'Telegram voice message sent');
    } catch (err) {
      logger.error(
        { jid, audioPath, err },
        'Failed to send Telegram voice message',
      );
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_EXTRA_BOTS']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }

  // Parse TELEGRAM_EXTRA_BOTS as JSON array
  let extraBots: Array<{ token: string; folder: string }> = [];
  const extraBotsEnv =
    process.env.TELEGRAM_EXTRA_BOTS || envVars.TELEGRAM_EXTRA_BOTS;
  if (extraBotsEnv) {
    try {
      extraBots = JSON.parse(extraBotsEnv);
      logger.info(
        { count: extraBots.length },
        'Telegram extra bots configured',
      );
    } catch (err) {
      logger.error(
        { err },
        'Failed to parse TELEGRAM_EXTRA_BOTS — must be valid JSON array',
      );
    }
  }

  return new TelegramChannel(token, opts, extraBots);
});
