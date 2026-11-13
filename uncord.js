import { Client, Events, GatewayIntentBits } from 'discord.js';
import { log } from './shared.js';

let callback = msg => log('Discord bot received a message:', msg)
let send2General

const dc = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] })
let general

dc.on(Events.MessageCreate, async msg => {
  if (msg.author.bot) return;
  if (msg.channelId !== process.env.DISCORD_CHANNEL_ID) return;
  switch (msg.content.trim().toLowerCase()) {
    case 'all hail the great tockdev!':
      msg.reply(':saluting_face:')
      return
    case 'All hail The Great kodigaming!':
      msg.reply(':saluting_face:')
      return
    case 'All hail The Great lmaokasdf123!':
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
      callback({
        content: msg.content,
        username: msg.author.displayName
      })
  }
})

export async function initDiscord(inboundCallback) {
  await dc.login(process.env.DISCORD_TOKEN)
  callback = inboundCallback
  return {
    send:
      await new Promise(res => {
        dc.on(Events.ClientReady, async client => {
          general = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID)
          send2General = text => {
            general.send(text)
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
