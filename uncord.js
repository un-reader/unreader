import { Client, Events, GatewayIntentBits } from 'discord.js';
import { log } from './shared.js';

let callback = msg => log('Discord bot received a message:', msg)
let send2General
let accountWebhook

const dc = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] })
let general

function discordErrorDetails(error) {
  return JSON.stringify({ name: error.name, code: error.code, status: error.status, message: error.message, method: error.method, url: error.url });
}

dc.on(Events.Error, error => log('Discord gateway error:', discordErrorDetails(error)));
dc.on('warn', warning => log('Discord gateway warning:', warning));
dc.on('shardDisconnect', (event, shardId) => log(`Discord shard disconnected: shard=${shardId} code=${event.code} reason=${event.reason || '(none)'}`));
dc.on('shardReconnecting', shardId => log(`Discord shard reconnecting: shard=${shardId}`));
dc.on('shardResume', (shardId, replayed) => log(`Discord shard resumed: shard=${shardId} replayed=${replayed}`));

function formatDiscordMessage(message) {
  const attachments = [...message.attachments.values()].map(file => file.url);
  const raw = [message.cleanContent || message.content || '', ...attachments].filter(Boolean).join('\n');
  const match = raw.match(/^\[([^\]]+)\]:\s*([\s\S]*)$/);
  return {
    id: message.id,
    username: match ? match[1] : message.author.displayName,
    sender: message.author.displayName,
    discord_user_id: message.author.id,
    discord_display_name: message.author.displayName,
    discord_username: message.author.username,
    is_unreader_account: !!match,
    content: match ? match[2] : raw,
    timestamp: message.createdTimestamp,
    discord_url: message.url,
    isMe: false,
    role: {},
    reactions: [],
  };
}

dc.on(Events.MessageCreate, async msg => {
  if (msg.author.bot) return;
  if (msg.channelId !== process.env.DISCORD_CHANNEL_ID) return;
  log(`Discord inbound: channel=${msg.channelId} user=${msg.author.username} id=${msg.id} attachments=${msg.attachments.size}`);
  switch (msg.content.trim().toLowerCase()) {
    case 'all hail the great tockdev!':
      msg.reply(':saluting_face:')
      return
    case 'all hail the great kodigaming!':
      msg.reply(':saluting_face:')
      return
    case 'all hail the great lmaokasdf123!':
      msg.reply(':saluting_face:')
      return
    case 'interlope':
      msg.reply('TO T.D, K.G and L.K')
      msg.reply('/portal-2d.html')
      msg.reply('console: INTERLOPE')
      msg.reply('Uncaught Error: Unknown command: INTERLOPE')
      msg.reply('    get https://unreader-2lz0.onrender.com/interlope.js:9')
      msg.reply('console: get("s.interlope.pull:27015")')
      msg.reply({
        files: [{
          attachment: 'https://static.wikitide.net/interloperwiki/3/33/Uman.jpg',
          name: 'Uman.jpg',
        }],
      })
      return
    default:
      try { callback(formatDiscordMessage(msg)); }
      catch (error) { log('Discord inbound relay callback failed:', discordErrorDetails(error)); }
  }
})

export async function initDiscord(inboundCallback) {
  log(`Discord login starting: token=${process.env.DISCORD_TOKEN ? 'configured' : 'missing'} channel=${process.env.DISCORD_CHANNEL_ID || 'missing'}`);
  await dc.login(process.env.DISCORD_TOKEN)
  log(`Discord login accepted: bot=${dc.user?.tag || dc.user?.username || 'unknown'}`);
  callback = inboundCallback
  return {
    history: async function () {
      if (!general) throw new Error('Discord channel is not ready.');
      log('Discord history request: latest 5');
      const messages = [...(await general.messages.fetch({ limit: 5 })).values()];
      return messages.reverse().map(formatDiscordMessage);
    },
    profile: async function (userId) {
      const user = await dc.users.fetch(userId);
      log(`Discord profile request: id=${userId}`);
      return {
        username: user.username,
        display_name: user.globalName || user.displayName || user.username,
        avatar_url: user.displayAvatarURL({ extension: 'png', size: 128 }),
      };
    },
    send:
      await new Promise(res => {
        const ready = async client => {
          try {
          general = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID)
          log(`Discord channel ready: id=${general.id} name=${general.name || 'unknown'} type=${general.type}`)
          try {
            const hooks = await general.fetchWebhooks()
            accountWebhook = hooks.find(hook => hook.name === 'UnReader account bridge')
            if (!accountWebhook) accountWebhook = await general.createWebhook({ name: 'UnReader account bridge' })
            log(`Discord webhook ready: id=${accountWebhook.id}`)
          } catch (error) {
            log('Discord webhook unavailable; using the bot identity:', discordErrorDetails(error))
          }
          send2General = payload => {
            const startedAt = Date.now();
            log(`Discord outbound start: transport=${accountWebhook && typeof payload === 'object' ? 'webhook' : 'bot'} contentLength=${String(payload.content || '').length} avatar=${!!payload.avatarURL}`)
            if (!accountWebhook || typeof payload !== 'object')
              return general.send(typeof payload === 'string' ? payload : payload.content)
                .then(message => { log(`Discord outbound success: message=${message.id} elapsed=${Date.now() - startedAt}ms`); return message; })
                .catch(error => { log(`Discord bot send failed after ${Date.now() - startedAt}ms:`, discordErrorDetails(error)); throw error; });
            return accountWebhook.send(payload).catch(error => {
              if (!payload.avatarURL) throw error;
              log('Discord webhook send failed with avatar; retrying without avatar:', discordErrorDetails(error));
              const fallback = { ...payload };
              delete fallback.avatarURL;
              return accountWebhook.send(fallback);
            }).then(message => { log(`Discord outbound success: message=${message.id} elapsed=${Date.now() - startedAt}ms`); return message; })
              .catch(error => { log(`Discord webhook send failed after ${Date.now() - startedAt}ms:`, discordErrorDetails(error)); throw error; });
          }
          res(send2General)
          } catch (error) {
            log('Discord channel initialization failed:', discordErrorDetails(error));
          }
        }
        if (dc.isReady()) ready(dc)
        else dc.once(Events.ClientReady, ready)
      })
  }
}

// Standalone test
if (import.meta.main) {
  const bot = await initDiscord(message => log(message.content))
  // bot.send('un-cord is up and running!')
}
