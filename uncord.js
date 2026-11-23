import { Client, Events, GatewayIntentBits } from 'discord.js';
import { log } from './shared.js';

let callback = msg => log('Discord bot received a message:', msg)
let send2General
let accountWebhook
const discordUsers = new Map();
const discordUsernames = new Map();

const dc = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  rest: { rejectOnRateLimit: ['/webhooks', '/channels/:id/messages'] },
})
let general

function discordErrorDetails(error) {
  return JSON.stringify({ name: error.name, code: error.code, status: error.status, message: error.message, method: error.method, url: error.url });
}

function rememberDiscordUser(user) {
  if (!user || !user.id || !user.username || user.bot) return null;
  const record = {
    id: user.id,
    username: user.username,
    display_name: user.globalName || user.displayName || user.username,
    avatar_url: user.displayAvatarURL({ extension: 'png', size: 64 }),
  };
  const previous = discordUsers.get(record.id);
  if (previous && discordUsernames.get(previous.username.toLowerCase()) === record.id)
    discordUsernames.delete(previous.username.toLowerCase());
  discordUsers.delete(record.id);
  discordUsers.set(record.id, record);
  discordUsernames.set(record.username.toLowerCase(), record.id);
  if (discordUsers.size > 200) {
    const oldestId = discordUsers.keys().next().value;
    const oldest = discordUsers.get(oldestId);
    discordUsers.delete(oldestId);
    if (oldest && discordUsernames.get(oldest.username.toLowerCase()) === oldestId)
      discordUsernames.delete(oldest.username.toLowerCase());
  }
  return record;
}

function resolveDiscordMentions(content) {
  const userIds = [];
  const resolvedContent = String(content || '').replace(/(^|[^A-Za-z0-9_.])@([A-Za-z0-9_.-]{2,32})\b/g, (match, before, username) => {
    const userId = discordUsernames.get(username.toLowerCase());
    if (!userId) return match;
    if (userIds.indexOf(userId) < 0) userIds.push(userId);
    return `${before}<@${userId}>`;
  }).replace(/<@!?([0-9]+)>/g, (match, userId) => {
    if (!discordUsers.has(userId)) return match;
    if (userIds.indexOf(userId) < 0) userIds.push(userId);
    return `<@${userId}>`;
  });
  return { content: resolvedContent, userIds };
}

dc.on(Events.Error, error => log('Discord gateway error:', discordErrorDetails(error)));
dc.rest.on('rateLimited', info => log(`Discord rate limited: route=${info.route} global=${info.global} retryAfter=${info.retryAfter}ms`));
dc.on('warn', warning => log('Discord gateway warning:', warning));
dc.on('shardDisconnect', (event, shardId) => log(`Discord shard disconnected: shard=${shardId} code=${event.code} reason=${event.reason || '(none)'}`));
dc.on('shardReconnecting', shardId => log(`Discord shard reconnecting: shard=${shardId}`));
dc.on('shardResume', (shardId, replayed) => log(`Discord shard resumed: shard=${shardId} replayed=${replayed}`));

function formatDiscordMessage(message) {
  const attachments = [...message.attachments.values()].map(file => file.url);
  const raw = [message.cleanContent || message.content || '', ...attachments].filter(Boolean).join('\n');
  const match = raw.match(/^\[([^\]]+)\]:\s*([\s\S]*)$/);
  rememberDiscordUser(message.author);
  const mentionedUsers = [...message.mentions.users.values()].map(rememberDiscordUser).filter(Boolean);
  const referenced = message.referencedMessage;
  const referencedRaw = referenced && (referenced.cleanContent || referenced.content || '');
  const referencedMatch = referencedRaw && referencedRaw.match(/^\[([^\]]+)\]:\s*([\s\S]*)$/);
  return {
    id: message.id,
    username: match ? match[1] : message.author.displayName,
    sender: message.author.displayName,
    discord_user_id: message.author.id,
    discord_display_name: message.author.displayName,
    discord_username: message.author.username,
    avatar_url: message.author.displayAvatarURL({ extension: 'png', size: 64 }),
    mentioned_users: mentionedUsers,
    reply_to: message.reference && message.reference.messageId ? {
      id: message.reference.messageId,
      username: referencedMatch ? referencedMatch[1] : referenced ? referenced.author.displayName : 'Discord user',
      content: referenced ? (referencedMatch ? referencedMatch[2] : referencedRaw) : '',
      unavailable: !referenced,
    } : null,
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
            const content = typeof payload === 'string' ? payload : payload.content;
            const resolved = resolveDiscordMentions(content);
            const replyContext = typeof payload === 'object' && payload.replyTo && payload.replyContext;
            const replyQuote = replyContext
              ? `> Replying to @${String(replyContext.username || 'Discord user').replace(/[\r\n]/g, ' ').slice(0, 64)}: ${String(replyContext.content || '').replace(/[\r\n]+/g, ' ').slice(0, 180)}\n\n`
              : '';
            const outboundContent = replyQuote + resolved.content;
            const userContent = typeof payload === 'object' && payload.username
              ? `[${payload.username}]: ${outboundContent}`
              : outboundContent;
            const allowedMentions = { parse: [], users: resolved.userIds };
            const sendAsBot = () => general.send({ content: userContent, allowedMentions })
              .then(message => { log(`Discord bot fallback success: message=${message.id} elapsed=${Date.now() - startedAt}ms`); return message; })
              .catch(error => { log(`Discord bot send failed after ${Date.now() - startedAt}ms:`, discordErrorDetails(error)); throw error; });
            if (!accountWebhook || typeof payload !== 'object') return sendAsBot();
            const webhookPayload = { ...payload, content: outboundContent, allowedMentions };
            delete webhookPayload.replyTo;
            delete webhookPayload.replyContext;
            const webhookSend = accountWebhook.send.bind(accountWebhook);
            return webhookSend(webhookPayload).then(message => {
              log(`Discord outbound success: message=${message.id} elapsed=${Date.now() - startedAt}ms`);
              return message;
            }).catch(error => {
              if (error.name && error.name.indexOf('RateLimitError[') === 0) {
                log('Discord webhook rate limit; sending through the bot account instead.');
                return sendAsBot();
              }
              if (payload.avatarURL && error.status === 400) {
                log('Discord rejected the avatar URL; retrying this message without an avatar.');
                const fallback = { ...webhookPayload };
                delete fallback.avatarURL;
                return webhookSend(fallback).then(message => {
                  log(`Discord outbound success without avatar: message=${message.id} elapsed=${Date.now() - startedAt}ms`);
                  return message;
                });
              }
              log(`Discord webhook send failed after ${Date.now() - startedAt}ms:`, discordErrorDetails(error));
              throw error;
            });
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
