import { Client, Events, GatewayIntentBits } from 'discord.js';
import { log } from './shared.js';

let callback = msg => log('Discord bot received a message:', msg)
let send2General
let accountWebhook

const dc = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] })
let general

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
      callback(formatDiscordMessage(msg))
  }
})

export async function initDiscord(inboundCallback) {
  await dc.login(process.env.DISCORD_TOKEN)
  callback = inboundCallback
  return {
    history: async function (page = 0) {
      if (!general) throw new Error('Discord channel is not ready.');
      const messages = [...(await general.messages.fetch({ limit: 100 })).values()];
      const start = Math.max(0, Number(page) || 0) * 10;
      return messages.slice(start, start + 10).reverse().map(formatDiscordMessage);
    },
    profile: async function (userId) {
      const user = await dc.users.fetch(userId);
      return {
        username: user.username,
        display_name: user.globalName || user.displayName || user.username,
        avatar_url: user.displayAvatarURL({ extension: 'png', size: 128 }),
      };
    },
    send:
      await new Promise(res => {
        dc.on(Events.ClientReady, async client => {
          general = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID)
          try {
            const hooks = await general.fetchWebhooks()
            accountWebhook = hooks.find(hook => hook.name === 'UnReader account bridge')
            if (!accountWebhook) accountWebhook = await general.createWebhook({ name: 'UnReader account bridge' })
          } catch (error) {
            log('Discord webhook unavailable; using the bot identity:', error.message)
          }
          send2General = payload => {
            if (!accountWebhook || typeof payload !== 'object')
              return general.send(typeof payload === 'string' ? payload : payload.content);
            return accountWebhook.send(payload).catch(error => {
              if (!payload.avatarURL) throw error;
              log('Discord avatar rejected; retrying message without avatar:', error.message);
              const fallback = { ...payload };
              delete fallback.avatarURL;
              return accountWebhook.send(fallback);
            });
          }
          res(send2General)
        })
      })
  }
}

// Standalone test
if (import.meta.main) {
  const bot = await initDiscord(message => log(message.content))
  // bot.send('un-cord is up and running!')
}
