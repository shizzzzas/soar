import 'dotenv/config';
import { Client, Collection, GatewayIntentBits } from 'discord.js';
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
import { getServerCounters, saveServerCounters, updateCounter } from './services/serverstatsService.js';
import { logger, startupLog, shutdownLog } from './utils/logger.js';
import { checkBirthdays } from './services/birthdayService.js';
import { checkGiveaways } from './services/giveawayService.js';
import { loadCommands, registerCommands as registerSlashCommands } from './handlers/loaders/commandLoader.js';
import { runSafeTask, handleTaskError, ErrorCodes } from './utils/errorHandler.js';
import { initializeMusic } from './services/music/riffySetup.js';
import { shutdownMusic } from './services/music/playerHandler.js';
import pkg from '../package.json' with { type: 'json' };
import { EXPECTED_SCHEMA_VERSION, EXPECTED_SCHEMA_LABEL } from './config/database/schemaVersion.js';

class TitanBot extends Client {
  constructor() {
    super({
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

    this.rest = new REST({ version: '10' }).setToken(config.bot.token);

    // Message commands / moderation / bot mention
    this.on('messageCreate', async (message) => {
      if (message.author.bot) return;

      const content = message.content.toLowerCase().trim();

      // Suicide / self-harm moderation filter
      const suicidePatterns = [
        /\bkill\s+myself\b/,
        /\bkill\s+me\b/,
        /\bkill\s+urself\b/,
        /\bkill\s+yourself\b/,
        /\bgo\s+kill\s+yourself\b/,
        /\bgo\s+kys\b/,
        /\bgo\s+die\b/,
        /\bdie\s+already\b/,
        /\bend\s+my\s+life\b/,
        /\bend\s+yourself\b/,
        /\btake\s+my\s+own\s+life\b/,
        /\bwant\s+to\s+die\b/,
        /\bwanna\s+die\b/,
        /\bgoing\s+to\s+die\b/,
        /\bgonna\s+die\b/,
        /\bcommit\s+suicide\b/,
        /\bcommitting\s+suicide\b/,
        /\bsuicide\s+attempt\b/,
        /\bsuicidal\b/,
        /\bi('m| am)\s+suicidal\b/,
        /\bi('m| am)\s+going\s+to\s+kill\s+myself\b/,
        /\bi('m| am)\s+gonna\s+kill\s+myself\b/,
        /\bi('m| am)\s+going\s+to\s+end\s+my\s+life\b/,
        /\bi('m| am)\s+gonna\s+end\s+my\s+life\b/,
        /\bkms\b/,
        /\bkys\b/,
        /\bk\s*m\s*s\b/,
        /\bk\s*y\s*s\b/,
        /\bkill\s+ur\s+self\b/,
        /\bkill\s+your\s+self\b/,
        /\bunalive\s+yourself\b/,
        /\bunalive\s+me\b/,
        /\bself[-\s]?delete\b/,
      ];

      if (suicidePatterns.some((pattern) => pattern.test(content))) {
        try {
          await message.delete();

          await message.channel.send(
            `nooo!!! thats bad!! stap!! 3: <@${message.author.id}>`
          );
        } catch (error) {
          logger.warn(
            'Failed to remove suicide-related message:',
            error.message
          );
        }

        return;
      }

      // Reply "Paris" when someone mentions the bot
      if (message.mentions.has(this.user)) {
        message.reply('Paris');
      }

      // Only this user can control the voice connection
      if (message.author.id !== '1542873926173069496') return;

      // !rvc = reconnect voice channel
      if (content === '!rvc') {
        this.voiceManuallyDisconnected = false;

        await this.joinMainVoiceChannel();

        message.reply('ok i reconnec ;3');
        return;
      }

      // !lvc = leave voice channel
      if (content === '!lvc') {
        this.voiceManuallyDisconnected = true;

        if (this.voiceConnection) {
          try {
            this.voiceConnection.destroy();
          } catch (error) {
            logger.warn('Voice disconnect warning:', error.message);
          }

          this.voiceConnection = null;
        }

        message.reply('nooooooo i cri 3: u bulli me.. bad isaac..');
      }
    });
  }

  async joinMainVoiceChannel() {
    const channelId = '1551388730709778512';

    // Don't automatically reconnect if !lvc was used
    if (this.voiceManuallyDisconnected) {
      return;
    }

    try {
      const channel = await this.channels.fetch(channelId);

      if (!channel || !channel.isVoiceBased()) {
        logger.error(`Voice channel ${channelId} was not found or is not a voice channel.`);
        return;
      }

      // Destroy an old connection before creating a new one
      if (this.voiceConnection) {
        try {
          this.voiceConnection.destroy();
        } catch {}
        this.voiceConnection = null;
      }

      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,

        // Unmuted but deafened
        selfDeaf: true,
        selfMute: false,
      });

      this.voiceConnection = connection;

      connection.on(VoiceConnectionStatus.Ready, () => {
        if (this.voiceManuallyDisconnected) return;

        startupLog(`✅ Joined voice channel: ${channel.name}`);
      });

      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        if (this.voiceManuallyDisconnected) {
          return;
        }

        logger.warn('⚠️ Voice connection disconnected. Attempting to reconnect...');

        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch {
          if (this.voiceManuallyDisconnected) {
            return;
          }

          logger.warn('Voice connection could not recover. Rejoining voice channel...');

          try {
            connection.destroy();
          } catch {}

          if (this.voiceConnection === connection) {
            this.voiceConnection = null;
          }

          setTimeout(() => {
            if (!this.voiceManuallyDisconnected) {
              this.joinMainVoiceChannel();
            }
          }, 2_000);
        }
      });

      connection.on(VoiceConnectionStatus.Destroyed, () => {
        if (this.voiceManuallyDisconnected) {
          return;
        }

        // Don't reconnect if this isn't the active connection anymore
        if (this.voiceConnection !== connection) {
          return;
        }

        logger.warn('⚠️ Voice connection destroyed. Rejoining...');

        this.voiceConnection = null;

        setTimeout(() => {
          if (!this.voiceManuallyDisconnected) {
            this.joinMainVoiceChannel();
          }
        }, 2_000);
      });

    } catch (error) {
      logger.error('Failed to join voice channel:', error);

      if (!this.voiceManuallyDisconnected) {
        setTimeout(() => {
          if (!this.voiceManuallyDisconnected) {
            this.joinMainVoiceChannel();
          }
        }, 5_000);
      }
    }
  }

  async start() {
    try {
      startupLog('Starting TitanBot...');
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      startupLog('Initializing database...');
      const dbInstance = await initializeDatabase();
      this.db = dbInstance.db;

      // Check database status and report
      const dbStatus = this.db.getStatus();
      if (dbStatus.isDegraded) {
        logger.warn('');
        logger.warn('╔═══════════════════════════════════════════════════════╗');
        logger.warn('║ ⚠️  DATABASE RUNNING IN DEGRADED MODE                 ║');
        logger.warn('║                                                       ║');
        logger.warn('║ Connection: In-Memory Storage (PostgreSQL unavailable)║');
        logger.warn('║ Data Persistence: DISABLED - data lost on restart    ║');
        logger.warn('║ Action Required: Fix PostgreSQL and restart bot      ║');
        logger.warn('╚═══════════════════════════════════════════════════════╝');
        logger.warn('');
      } else {
        startupLog(`✅ Database Status: ${dbStatus.connectionType} (fully operational)`);
      }
      
      startupLog('Starting web server...');
      this.startWebServer();
      
      startupLog('Loading commands...');
      await loadCommands(this);
      startupLog(`Commands loaded: ${this.commands.size}`);
      
      startupLog('Loading handlers...');
      await this.loadHandlers();
      startupLog('Handlers loaded');

      initializeMusic(this);
      
      startupLog('Logging into Discord...');
      await this.login(this.config.bot.token);
      startupLog('Discord login successful');

      await this.joinMainVoiceChannel();
      
      startupLog('Registering slash commands globally...');
      await this.registerCommands();
      startupLog('Slash commands registration complete');
      
      const databaseMode = dbStatus.isDegraded
        ? 'Optional in-memory mode (data resets after restart)'
        : 'Connected (persistent data enabled)';
      const handlerSummary = `${this.buttons.size} buttons, ${this.selectMenus.size} menus, ${this.modals.size} modals`;
      startupLog(
        `ONLINE ✅ | ${this.commands.size} commands loaded | ${handlerSummary} | Database: ${databaseMode}`
      );
      
      this.setupCronJobs();
    } catch (error) {
      logger.error('Failed to start bot:', error);
      process.exit(1);
    }
  }

  startWebServer() {
    const app = express();
    const configuredPort = Number(this.config.api?.port || process.env.PORT || 3000);
    const maxPortRetryAttempts = Number(process.env.PORT_RETRY_ATTEMPTS || 5);
    const host = process.env.WEB_HOST || '0.0.0.0';
    const corsOrigin = this.config.api?.cors?.origin || '*';
    
    app.use((req, res, next) => {
      const allowedOrigins = Array.isArray(corsOrigin) ? corsOrigin : [corsOrigin];
      const origin = req.headers.origin;
      
      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin || '*');
      }
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      
      if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
      }
      next();
    });

    const requestCounts = new Map();
    const windowMs = this.config.api?.rateLimit?.windowMs || 60000;
    const maxRequests = this.config.api?.rateLimit?.max || 100;
    
    app.use((req, res, next) => {
      const ip = req.ip;
      const now = Date.now();
      const windowStart = now - windowMs;
      
      if (!requestCounts.has(ip)) {
        requestCounts.set(ip, []);
      }
      
      const times = requestCounts.get(ip).filter(t => t > windowStart);
      
      if (times.length >= maxRequests) {
        return res.status(429).json({ error: 'Too many requests' });
      }
      
      times.push(now);
      requestCounts.set(ip, times);
      next();
    });

    app.get('/health', (req, res) => {
      const dbStatus = this.db?.getStatus?.() || { isDegraded: 'unknown' };
      const status = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: {
          connected: dbStatus.connectionType !== 'none',
          degraded: dbStatus.isDegraded,
          type: dbStatus.connectionType
        }
      };
      res.status(200).json(status);
    });

    app.get('/ready', (req, res) => {
      const dbStatus = this.db?.getStatus?.() || { isDegraded: true, connectionType: 'none' };
      const isReady = this.isReady() && !dbStatus.isDegraded;

      const metrics = {
        guildCount: this.guilds?.cache?.size ?? 0,
        commandCount: this.commands?.size ?? 0,
        database: {
          mode: dbStatus.connectionType,
          degraded: dbStatus.isDegraded,
          degradedReason: dbStatus.degradedReason ?? null,
        },
        schemaVersion: EXPECTED_SCHEMA_VERSION,
        schemaLabel: EXPECTED_SCHEMA_LABEL,
      };

      if (isReady) {
        return res.status(200).json({
          ready: true,
          message: 'Bot is ready',
          metrics,
        });
      }

      res.status(503).json({
        ready: false,
        reason: !this.isReady() ? 'Bot not Ready' : 'Database degraded',
        metrics,
      });
    });

    app.get('/', (req, res) => {
      res.status(200).json({ 
        message: 'TitanBot System Online',
        version: pkg.version,
        timestamp: new Date().toISOString()
      });
    });

    const startServer = (port, attempt = 0) => {
      let hasStartedListening = false;
      const server = app.listen(port, host, () => {
        hasStartedListening = true;
        this.webServer = server;
        startupLog(`✅ Web Server running on ${host}:${port}`);
        startupLog(`Health endpoint: http://${host}:${port}/health`);
        startupLog(`Ready endpoint: http://${host}:${port}/ready`);
      });

      server.on('error', (error) => {
        const errorCode = error?.code || 'UNKNOWN_ERROR';
        const errorMessage = error?.message || 'Unknown server error';

        if (!hasStartedListening && errorCode === 'EADDRINUSE' && attempt < maxPortRetryAttempts) {
          const nextPort = port + 1;
          startupLog(`Port ${port} is already in use. Trying port ${nextPort}...`);
          setTimeout(() => startServer(nextPort, attempt + 1), 250);
          return;
        }

        if (hasStartedListening && errorCode === 'EADDRINUSE') {
          logger.warn(`Web server reported a duplicate bind warning on ${host}:${port}, but the bot remains online.`);
          return;
        }

        logger.error(`❌ Web server error on port ${port} (${errorCode}): ${errorMessage}`);

        if (!hasStartedListening) {
          process.exit(1);
        }
      });
    };

    startServer(configuredPort, 0);
  }

  setupCronJobs() {
    cron.schedule('0 6 * * *', runSafeTask('birthday_check', () => checkBirthdays(this)));
    cron.schedule('* * * * *', runSafeTask('giveaway_check', () => checkGiveaways(this)));
    cron.schedule('*/15 * * * *', runSafeTask('counter_update', () => this.updateAllCounters()));
  }

  async updateAllCounters() {
    if (!this.db) {
      logger.warn('Database not available for counter updates');
      return;
    }
    
    for (const [guildId, guild] of this.guilds.cache) {
      try {
        const counters = await getServerCounters(this, guildId);
        const validCounters = [];
        const orphanedCounters = [];
        
        for (const counter of counters) {
          if (counter && counter.type && counter.channelId && counter.enabled !== false) {
            const channel = guild.channels.cache.get(counter.channelId);
            if (channel) {
              validCounters.push(counter);
              await updateCounter(this, guild, counter);
            } else {
              orphanedCounters.push(counter);
              logger.info(`Removing orphaned counter ${counter.id} (type: ${counter.type}, deleted channel: ${counter.channelId}) from guild ${guildId}`);
            }
          }
        }
        
        // Save cleaned counters if any were orphaned
        // Save cleaned counters if any were orphaned
        if (orphanedCounters.length > 0) {
          await saveServerCounters(this, guildId, validCounters);
          logger.info(`Cleaned up ${orphanedCounters.length} orphaned counter(s) from guild ${guildId} during scheduled update`);
        }
      } catch (error) {
        logger.error(`Error updating counters for guild ${guildId}:`, error);
      }
    }
  }

  async loadHandlers() {
    startupLog('Loading handlers...');
    const handlers = [
      { path: 'events', type: 'default', required: true },
      { path: 'interactions', type: 'default', required: true }
    ];

    for (const handler of handlers) {
      try {
        startupLog(`Loading handler: ${handler.path}`);
        const module = await import(`./handlers/loaders/${handler.path}.js`);
        const loaderFn = handler.type.startsWith('named:')
          ? module[handler.type.split(':')[1]]
          : module.default;

        if (typeof loaderFn === 'function') {
          await loaderFn(this);
          startupLog(`✅ Loaded ${handler.path}`);
        } else {
          throw new Error(`Invalid loader export from ${handler.path}`);
        }
      } catch (error) {
        if (handler.required) {
          logger.error(`❌ Failed to load required handler ${handler.path}:`, error.message);
          throw error;
        } else if (error.code !== 'MODULE_NOT_FOUND') {
          logger.warn(`⚠️  Failed to load optional handler ${handler.path}:`, error.message);
        }
      }
    }
  }

  async registerCommands() {
    try {
      await registerSlashCommands(this, { clientId: this.config.bot.clientId });
    } catch (error) {
      logger.error('Error registering commands:', error);
    }
  }

  async shutdown(reason = 'UNKNOWN') {
    shutdownLog(`Bot is shutting down (${reason})...`);
    logger.info(`\n${'='.repeat(60)}`);
    logger.info(`🛑 Graceful Shutdown Initiated (${reason})`);
    logger.info(`${'='.repeat(60)}`);

    try {
      
      logger.info('Stopping cron jobs...');
      cron.getTasks().forEach(task => task.stop());
      logger.info('✅ Cron jobs stopped');

      logger.info('Stopping music players...');
      await shutdownMusic(this);
      logger.info('✅ Music players stopped');

      if (this.voiceConnection) {
        logger.info('Disconnecting voice connection...');
        try {
          this.voiceManuallyDisconnected = true;
          this.voiceConnection.destroy();
        } catch (error) {
          logger.warn('Voice connection shutdown warning:', error.message);
        }
        this.voiceConnection = null;
        logger.info('✅ Voice connection closed');
      }

      if (this.webServer) {
        logger.info('Closing web server...');
        await new Promise((resolve) => this.webServer.close(resolve));
        logger.info('✅ Web server closed');
      }

      // Close database connection
      // Close database connection
      if (this.db && this.db.db) {
        logger.info('Closing database connection...');
        try {
          if (this.db.db.pool) {
            await this.db.db.pool.end();
            logger.info('✅ Database connection closed');
          }
        } catch (error) {
          logger.warn('Error closing database pool:', error.message);
        }
      }

      logger.info('Destroying Discord client...');
      if (this.isReady()) {
        try {
          this.destroy();
          logger.info('✅ Discord client destroyed');
        } catch (error) {
          logger.warn('Discord client destroy warning (non-critical):', error.message);
        }
      }

      logger.info('✅ Graceful shutdown complete');
      shutdownLog('Bot stopped successfully.');
      process.exit(0);
    } catch (error) {
      logger.error('Error during graceful shutdown:', error);
      process.exit(1);
    }
  }
}

try {
  const bot = new TitanBot();
  
  const setupShutdown = () => {
    process.on('SIGTERM', () => bot.shutdown('SIGTERM'));
    process.on('SIGINT', () => bot.shutdown('SIGINT'));
    
    process.on('uncaughtException', (error) => {
      // Process state may be corrupt after an uncaught throw; log and shut down cleanly.
      handleTaskError('uncaught_exception', error, { fatal: true });
      bot.shutdown('UNCAUGHT_EXCEPTION');
    });

    process.on('unhandledRejection', (reason) => {
      const code = reason?.code;
      if (code === 10062 || code === 40060 || code === 50027) {
        logger.warn('Recoverable Discord interaction rejection:', reason?.message || reason);
        return;
      }
      if (reason?.message?.includes('Queue is empty')) {
        return;
      }

      // A stray rejection is a bug to fix, not a reason to take the bot down.
      // Log loudly with full context; the central task handler categorizes it.
      handleTaskError('unhandled_rejection', reason instanceof Error ? reason : new Error(String(reason)), {
        errorCode: ErrorCodes.UNHANDLED_REJECTION,
      });
    });
  };
  
  setupShutdown();
  bot.start().catch((error) => {
    logger.error('Fatal error during bot startup:', error);
    bot.shutdown('STARTUP_ERROR');
  });
} catch (error) {
  logger.error('Fatal error during bot startup:', error);
  process.exit(1);
}

export default TitanBot;
