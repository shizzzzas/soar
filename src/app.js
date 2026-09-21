import 'dotenv/config';
import {
  Client,
  Collection,
  GatewayIntentBits,
  Partials,
} from 'discord.js';
import { REST } from '@discordjs/rest';
import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
} from '@discordjs/voice';
import express from 'express';
import cron from 'node-cron';
import config from './config/application.js';
import { getGuildConfig } from './services/config/guildConfig.js';
import { initializeDatabase } from './utils/database.js';
import {
  getServerCounters,
  saveServerCounters,
  updateCounter,
} from './services/serverstatsService.js';
import {
  logger,
  startupLog,
  shutdownLog,
} from './utils/logger.js';
import { checkBirthdays } from './services/birthdayService.js';
import { checkGiveaways } from './services/giveawayService.js';
import {
  loadCommands,
  registerCommands as registerSlashCommands,
} from './handlers/loaders/commandLoader.js';
import {
  runSafeTask,
  handleTaskError,
  ErrorCodes,
} from './utils/errorHandler.js';
import { initializeMusic } from './services/music/riffySetup.js';
import { shutdownMusic } from './services/music/playerHandler.js';
import pkg from '../package.json' with { type: 'json' };
import {
  EXPECTED_SCHEMA_VERSION,
  EXPECTED_SCHEMA_LABEL,
} from './config/database/schemaVersion.js';

class TitanBot extends Client {
  constructor() {
    super({
      partials: [Partials.Channel],

      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildBans,
      ],
    });

    this.config = config;
    this.commands = new Collection();
    this.events = new Collection();
    this.buttons = new Collection();
    this.selectMenus = new Collection();
    this.modals = new Collection();
    this.cooldowns = new Collection();
    this.db = null;

    // Voice control state
    this.voiceConnection = null;
    this.voiceManuallyDisconnected = false;

    // CSAY state
    this.csaySession = null;

    this.rest = new REST({ version: '10' }).setToken(
      config.bot.token
    );
  }

  setupMessageHandlers() {
    const CONTROL_USER_IDS = [
      '1542873926173069496',
      '1294901561897648178',
    ];

    const canControl = (userId) =>
      CONTROL_USER_IDS.includes(userId);

    this.on('messageCreate', async (message) => {
      try {
        if (message.author.bot) return;

        const content = message.content.trim();
        const isController = canControl(message.author.id);

        // ==========================================
        // CONTROLLER-ONLY ECHO
        // ==========================================
        if (
          !message.channel.isDMBased() &&
          isController &&
          content.toLowerCase().startsWith('!echo ')
        ) {
          const echoText = message.content.slice(6);

          if (!echoText.trim()) {
            return;
          }

          await message.channel.send(echoText);
          await message.delete();

          return;
        }

        // ==========================================
        // DMs / CSAY
        // ==========================================
        if (message.channel.isDMBased()) {
          // Only controllers can use CSAY
          if (!isController) {
            return;
          }

          // ==========================================
          // STOP CSAY
          // ==========================================
          if (content.toLowerCase() === '!cstop') {
            if (!this.csaySession) {
              await message.reply('nothing to stop :3');
              return;
            }

            this.csaySession = null;

            await message.reply('stopped :3');
            return;
          }

          // ==========================================
          // START CSAY
          // ==========================================
          if (content.toLowerCase() === '!csay') {
            if (this.csaySession) {
              await message.reply('already csaying :3');
              return;
            }

            const guilds = [...this.guilds.cache.values()];

            if (guilds.length === 0) {
              await message.reply(
                'im not in any servers :('
              );
              return;
            }

            this.csaySession = {
              stage: 'guild',
              guilds,
              guild: null,
              channels: [],
              channel: null,
              controllerId: message.author.id,
            };

            const serverList = guilds
              .map(
                (guild, index) =>
                  `${index + 1}. ${guild.name}`
              )
              .join('\n');

            await message.reply(
              `servers:\n\n${serverList}\n\nsend the number of the server`
            );

            return;
          }

          const session = this.csaySession;

          // ==========================================
          // SERVER SELECTION
          // ==========================================
          if (session && session.stage === 'guild') {
            if (session.controllerId !== message.author.id) {
              return;
            }

            const choice = Number.parseInt(
              content,
              10
            );

            if (
              Number.isNaN(choice) ||
              choice < 1 ||
              choice > session.guilds.length
            ) {
              await message.reply(
                'pick a valid server number'
              );
              return;
            }

            const guild =
              session.guilds[choice - 1];

            const channels = [
              ...guild.channels.cache.values(),
            ]
              .filter(
                (channel) =>
                  channel.isTextBased() &&
                  !channel.isDMBased()
              )
              .sort((a, b) => {
                const aPosition = a.position ?? 0;
                const bPosition = b.position ?? 0;

                return aPosition - bPosition;
              });

            if (channels.length === 0) {
              await message.reply(
                'that server has no usable text channels :('
              );

              this.csaySession = null;
              return;
            }

            session.guild = guild;
            session.channels = channels;
            session.stage = 'channel';

            const channelList = channels
              .map((channel, index) => {
                const name = channel.parent
                  ? `${channel.parent.name} / #${channel.name}`
                  : `#${channel.name}`;

                return `${index + 1}. ${name}`;
              })
              .join('\n');

            await message.reply(
              `hhhhhh, what channel do i send stuff in\n\n${channelList}\n\nsend the number of the channel`
            );

            return;
          }

          // ==========================================
          // CHANNEL SELECTION
          // ==========================================
          if (session && session.stage === 'channel') {
            if (session.controllerId !== message.author.id) {
              return;
            }

            const choice = Number.parseInt(
              content,
              10
            );

            if (
              Number.isNaN(choice) ||
              choice < 1 ||
              choice > session.channels.length
            ) {
              await message.reply(
                'pick a valid channel number'
              );
              return;
            }

            const channel =
              session.channels[choice - 1];

            session.channel = channel;
            session.stage = 'active';

            await message.reply(
              `ok ${message.author.displayName}`
            );

            return;
          }

          // ==========================================
          // ACTIVE CSAY
          // ==========================================
          if (
            session &&
            session.stage === 'active'
          ) {
            if (session.controllerId !== message.author.id) {
              return;
            }

            if (!session.channel) {
              await message.reply(
                'something broke :('
              );

              this.csaySession = null;
              return;
            }

            try {
              // Send EXACTLY what the controller said.
              await session.channel.send(
                message.content
              );
            } catch (error) {
              logger.warn(
                'Failed to send CSAY message:',
                error.message
              );

              await message.reply(
                'i couldnt send that message to the channel :('
              );
            }

            return;
          }

          return;
        }

        // ==========================================
        // PARIS
        // Only happens when someone mentions bot
        // ==========================================
        if (
          this.user &&
          message.mentions.has(this.user)
        ) {
          await message.reply('Paris');
        }

        // ==========================================
        // CONTROLLER-ONLY COMMANDS
        // ==========================================
        if (!isController) {
          return;
        }

        // ==========================================
        // RECONNECT VOICE
        // ==========================================
        if (content.toLowerCase() === '!rvc') {
          this.voiceManuallyDisconnected = false;

          await this.joinMainVoiceChannel();

          await message.reply(
            'ok i reconnec ;3'
          );

          return;
        }

        // ==========================================
        // LEAVE VOICE
        // ==========================================
        if (content.toLowerCase() === '!lvc') {
          this.voiceManuallyDisconnected = true;

          if (this.voiceConnection) {
            try {
              this.voiceConnection.destroy();
            } catch {}
          }

          this.voiceConnection = null;

          await message.reply(
            'nooooooo i cri 3: u bulli me.. bad isaac..'
          );

          return;
        }
      } catch (error) {
        logger.error(
          'messageCreate handler error:',
          error
        );
      }
    });

    // ==========================================
    // SERVER → CSAY CONTROLLER DM
    // ==========================================
    this.on('messageCreate', async (message) => {
      try {
        if (message.author.bot) return;

        const session = this.csaySession;

        if (
          !session ||
          session.stage !== 'active'
        ) {
          return;
        }

        if (
          !session.guild ||
          !session.channel
        ) {
          return;
        }

        // Only selected server
        if (
          message.guildId !==
          session.guild.id
        ) {
          return;
        }

        // Only selected channel
        if (
          message.channelId !==
          session.channel.id
        ) {
          return;
        }

        const authorMention =
          `<@${message.author.id}>`;

        const content =
          message.content || '[no text]';

        const replyInfo = message.reference
          ? '\n↩️ replied to a message'
          : '';

        const attachments =
          message.attachments.size > 0
            ? `\n📎 ${[
                ...message.attachments.values(),
              ]
                .map(
                  (attachment) =>
                    attachment.url
                )
                .join('\n')}`
            : '';

        await this.users.send(
          session.controllerId,
          `${authorMention} said: ${content}${replyInfo}${attachments}`
        );
      } catch (error) {
        logger.warn(
          'Failed to send CSAY server message to controller:',
          error.message
        );
      }
    });
  }

  async joinMainVoiceChannel() {
    const channelId =
      '1551388730709778512';

    if (this.voiceManuallyDisconnected) {
      return;
    }

    try {
      const channel =
        await this.channels.fetch(
          channelId
        );

      if (
        !channel ||
        !channel.isVoiceBased()
      ) {
        logger.warn(
          'Target voice channel not found or is not voice based.'
        );

        return;
      }

      if (this.voiceConnection) {
        try {
          this.voiceConnection.destroy();
        } catch {}
      }

      const connection =
        joinVoiceChannel({
          channelId: channel.id,
          guildId: channel.guild.id,
          adapterCreator:
            channel.guild
              .voiceAdapterCreator,
          selfDeaf: true,
          selfMute: false,
        });

      this.voiceConnection =
        connection;

      connection.on(
        VoiceConnectionStatus.Ready,
        () => {
          startupLog(
            `Voice connected to #${channel.name}`
          );
        }
      );

      connection.on(
        VoiceConnectionStatus.Disconnected,
        async () => {
          if (
            this.voiceManuallyDisconnected
          ) {
            return;
          }

          try {
            await entersState(
              connection,
              VoiceConnectionStatus.Signalling,
              5_000
            );
          } catch {
            if (
              !this.voiceManuallyDisconnected
            ) {
              try {
                connection.destroy();
              } catch {}

              this.voiceConnection =
                null;

              setTimeout(() => {
                this.joinMainVoiceChannel();
              }, 5_000);
            }
          }
        }
      );

      connection.on(
        VoiceConnectionStatus.Destroyed,
        () => {
          if (
            this.voiceManuallyDisconnected
          ) {
            return;
          }

          this.voiceConnection =
            null;

          setTimeout(() => {
            this.joinMainVoiceChannel();
          }, 5_000);
        }
      );
    } catch (error) {
      logger.warn(
        'Failed to join main voice channel:',
        error.message
      );

      if (
        !this.voiceManuallyDisconnected
      ) {
        setTimeout(() => {
          this.joinMainVoiceChannel();
        }, 5_000);
      }
    }
  }

  async start() {
    try {
      startupLog(
        `Starting ${pkg.name} v${pkg.version}`
      );

      this.db =
        await initializeDatabase();

      startupLog(
        'Database initialized'
      );

      const webApp = express();

      webApp.get('/', (_req, res) => {
        res.send(
          'TitanBot online'
        );
      });

      webApp.listen(
        process.env.PORT || 3000,
        () => {
          startupLog(
            `Web server listening on port ${
              process.env.PORT || 3000
            }`
          );
        }
      );

      await loadCommands(this);

      startupLog(
        `${this.commands.size} commands loaded`
      );

      await initializeMusic(this);

      this.setupMessageHandlers();

      await this.login(
        config.bot.token
      );

      await this.joinMainVoiceChannel();

      await registerSlashCommands(
        this
      );

      cron.schedule(
        '0 0 * * *',
        async () => {
          await runSafeTask(
            'daily birthday check',
            () => checkBirthdays(this),
            handleTaskError
          );
        }
      );

      cron.schedule(
        '*/5 * * * *',
        async () => {
          await runSafeTask(
            'giveaway check',
            () => checkGiveaways(this),
            handleTaskError
          );
        }
      );

      startupLog(
        `ONLINE ✅ | ${this.commands.size} commands loaded | Database: Connected (persistent data enabled)`
      );
    } catch (error) {
      logger.error(
        'Failed to start TitanBot:',
        error
      );

      process.exit(1);
    }
  }

  async shutdown() {
    try {
      shutdownLog(
        'Shutting down TitanBot...'
      );

      this.voiceManuallyDisconnected =
        true;

      if (this.voiceConnection) {
        try {
          this.voiceConnection.destroy();
        } catch {}
      }

      this.voiceConnection = null;

      this.csaySession = null;

      await shutdownMusic(this);

      if (this.db) {
        await this.db.end();
      }

      this.destroy();

      shutdownLog(
        'TitanBot shut down successfully'
      );
    } catch (error) {
      logger.error(
        'Error during shutdown:',
        error
      );
    }
  }
}

const bot = new TitanBot();

process.on('SIGINT', async () => {
  await bot.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await bot.shutdown();
  process.exit(0);
});

bot.start();

export default TitanBot;
