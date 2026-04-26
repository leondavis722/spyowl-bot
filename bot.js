const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const axios = require('axios');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = '8693355387:AAER0dEuDTmELTYAXrrRQ8nmGkO2C_e83tc';
const CHAT_ID = '-1003614574645';
const API_BASE = 'https://api.spyowl.icu';
const SESSION_COOKIE = '__Secure-spyowl.session_token_multi-pombn0rxgve7kcp3chmdiwpnhjplkdvh=pombn0RxGve7kcp3CHMdIwPNhjPlkdvh.ONTqLRJ3sd6Aw0Gl7fXnzGu1%2BHO6mztgWI1lsMrSmu8%3D;__Secure-spyowl.session_token=pombn0RxGve7kcp3CHMdIwPNhjPlkdvh.ONTqLRJ3sd6Aw0Gl7fXnzGu1%2BHO6mztgWI1lsMrSmu8%3D';

const WATCHED_GEOS = new Set([
  'AT','BE','BG','CH','CZ','DK','ES','FR','GB','GR','HR','HU','IE','IS','IT',
  'NL','NO','PL','PT','RO','SE','SI','SK','TR',
  'AE','BH','QA','SA',
  'BR','CA','CL','CO','EC','GT','MX','PA','PE','PY',
  'HK','JP','MY','NZ','PH','SG','TW'
]);

async function apiGet(path) {
  const resp = await axios.get(`${API_BASE}${path}`, {
    headers: { Cookie: SESSION_COOKIE },
    timeout: 15000
  });
  return resp.data;
}

async function fetchVideoPage(skip, limit = 100) {
  return apiGet(`/creative/all?skip=${skip}&limit=${limit}&creativeType=video&pageType=all`);
}

function formatDate(d) {
  return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
}

function parseDate(str) {
  const [day, month] = str.split('.');
  const year = new Date().getFullYear();
  return `${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}`;
}

function fmtDateISO(iso) {
  const [,month, day] = iso.split('-');
  return `${parseInt(day)}.${parseInt(month)}`;
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ─── התראה יומית ─────────────────────────────────────────────────────────────
async function sendWaveAlert(isWave2) {
  const now = new Date();
  const todayISO = now.toISOString().split('T')[0];
  const sinceISO = isWave2
    ? `${todayISO}T14:00:00.000Z`
    : `${todayISO}T00:00:00.000Z`;

  const byGeo = {};
  let skip = 0;

  outer: while (true) {
    const data = await fetchVideoPage(skip);
    if (!data.creatives || data.creatives.length === 0) break;

    for (const c of data.creatives) {
      if (c.createdAt < sinceISO) break outer;
      if (WATCHED_GEOS.has(c.geo)) {
        byGeo[c.geo] = (byGeo[c.geo] || 0) + 1;
      }
    }

    if (!data.hasMore) break;
    skip += 100;
  }

  const entries = Object.entries(byGeo).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return;

  const title = isWave2
    ? `🦉 *SpyOwl Daily Summary — ${formatDate(now)}*`
    : `🦉 *SpyOwl Update — ${formatDate(now)}*`;

  let msg = `${title}\n\n🎬 ${isWave2 ? 'Total Videos Today' : 'New Videos'}:\n`;
  for (const [geo, count] of entries) msg += `${geo} — ${count}\n`;

  await bot.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
}

// ─── היסטוריה לפי מדינה ──────────────────────────────────────────────────────
bot.onText(/^([A-Za-z]{2})$/, async (msg, match) => {
  const geo = match[1].toUpperCase();
  const chatId = msg.chat.id;
  try {
    await bot.sendMessage(chatId, `🔍 Fetching history for ${geo}...`);

    const byDate = {};
    let skip = 0;

    while (skip <= 2000) {
      const data = await fetchVideoPage(skip);
      if (!data.creatives || data.creatives.length === 0) break;

      for (const c of data.creatives) {
        if (c.geo === geo) {
          const date = c.createdAt.split('T')[0];
          byDate[date] = (byDate[date] || 0) + 1;
        }
      }

      if (Object.keys(byDate).length >= 5) break;
      if (!data.hasMore) break;
      skip += 100;
    }

    if (Object.keys(byDate).length === 0)
      return bot.sendMessage(chatId, `❌ No videos found for ${geo}`);

    const dates = Object.entries(byDate)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 5);

    let msg = `🎬 *${geo} — Last videos:*\n\n`;
    for (const [iso, count] of dates)
      msg += `📅 ${fmtDateISO(iso)} — ${count} video${count > 1 ? 's' : ''}\n`;

    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });

  } catch (err) {
    console.error(err.message);
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// ─── סרטונים ביום ספציפי ─────────────────────────────────────────────────────
bot.onText(/^\/get ([A-Za-z]{2}) (\d{1,2}\.\d{1,2})$/i, async (msg, match) => {
  const geo = match[1].toUpperCase();
  const dateInput = match[2];
  const dateISO = parseDate(dateInput);
  const chatId = msg.chat.id;
  try {
    await bot.sendMessage(chatId, `🔍 Fetching ${geo} videos for ${dateInput}...`);

    const videos = [];
    let skip = 0;

    outer: while (true) {
      const data = await fetchVideoPage(skip);
      if (!data.creatives || data.creatives.length === 0) break;

      for (const c of data.creatives) {
        const cDate = c.createdAt.split('T')[0];
        if (cDate < dateISO) break outer;
        if (cDate === dateISO && c.geo === geo) videos.push(c);
      }

      if (!data.hasMore) break;
      skip += 100;
    }

    if (videos.length === 0)
      return bot.sendMessage(chatId, `❌ No videos found for ${geo} on ${dateInput}`);

    await bot.sendMessage(chatId,
      `🎬 *${geo} — ${dateInput} (${videos.length} video${videos.length > 1 ? 's' : ''})*`,
      { parse_mode: 'Markdown' }
    );

    const spyLink = `https://app.spyowl.icu/home?geo=${geo}&creativeType=video`;

    for (const creative of videos) {
      const celebrity = creative.celebrityName || 'Not mentioned';
      const offerLink = creative.linkUrl || '';
      const videoUrl = `${API_BASE}/s3/creatives/${creative._id}/mediaFile.mp4`;
      const caption = `👤 *${celebrity}*\n🔗 [Offer](${offerLink})\n🔎 [SpyOwl](${spyLink})\n🆔 ${creative._id}`;

      // הורד עם Cookie ושלח כ-buffer
      try {
        const videoResp = await axios.get(videoUrl, {
          headers: { Cookie: SESSION_COOKIE },
          responseType: 'arraybuffer',
          timeout: 60000
        });
        const buffer = Buffer.from(videoResp.data);
        await bot.sendVideo(chatId, buffer, { caption, parse_mode: 'Markdown' }, { filename: 'video.mp4', contentType: 'video/mp4' });
      } catch (e) {
        console.error('Video error:', e.message);
        await bot.sendMessage(chatId, `${caption}\n\n⚠️ Video not available`, { parse_mode: 'Markdown', disable_web_page_preview: true });
      }

      await new Promise(r => setTimeout(r, 300));
    }

  } catch (err) {
    console.error(err.message);
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// ─── offer (reply) ────────────────────────────────────────────────────────────
bot.onText(/^offer$/i, async (msg) => {
  const chatId = msg.chat.id;
  const replyText = msg.reply_to_message?.text || msg.reply_to_message?.caption || '';
  // חלץ את ה-ID (24 תווים hex)
  const idMatch = replyText.match(/([a-f0-9]{24})/);

  if (!idMatch)
    return bot.sendMessage(chatId, '❌ Reply to a video message and write "offer"');

  const creativeId = idMatch[1];

  // קבל את ה-offer link ישירות מה-API
  let offerLink = '';
  try {
    const creativeData = await apiGet(`/creative/${creativeId}`);
    offerLink = creativeData.linkUrl || '';
  } catch(e) { console.error('Creative fetch error:', e.message); }

  try {
    await bot.sendMessage(chatId, '🔍 Fetching offer...');

    // תמונת preview של הלנד — קבל URL של AWS ושלח לטלגרם ישירות
    try {
      const signedResp = await axios.get(
        `${API_BASE}/s3/signed-link/${creativeId}/full_preview.webp`,
        { headers: { Cookie: SESSION_COOKIE }, timeout: 10000 }
      );
      const awsUrl = signedResp.data?.url;
      if (awsUrl) {
        await bot.sendPhoto(chatId, awsUrl, { caption: '🖼️ Land Preview' });
      }
    } catch (e) {
      console.error('Preview error:', e.message);
    }

    // קובץ הלנד (archive)
    try {
      const archiveResp = await axios.get(
        `${API_BASE}/s3/?file=archive&id=${creativeId}`,
        { headers: { Cookie: SESSION_COOKIE }, responseType: 'arraybuffer', timeout: 30000 }
      );
      const archiveBuf = Buffer.from(archiveResp.data);
      await bot.sendDocument(chatId, archiveBuf, { caption: `🔗 Offer: ${offerLink}` }, { filename: 'land.zip', contentType: 'application/zip' });
    } catch (e) {
      console.error('Archive error:', e.message);
      await bot.sendMessage(chatId, `🔗 *Offer:*\n${offerLink}`, { parse_mode: 'Markdown' });
    }

  } catch (err) {
    console.error(err.message);
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// ─── פקודת new ───────────────────────────────────────────────────────────────
bot.onText(/^new$/i, async (msg) => {
  const chatId = msg.chat.id;
  try {
    await bot.sendMessage(chatId, '🔍 Checking latest updates...');

    // סרוק דפים עד שמוצאים תאריך שיש בו סרטונים במדינות הנצפות
    let latestDate = null;
    const byGeo = {};
    let skip = 0;

    outer: while (skip <= 1000) {
      const data = await fetchVideoPage(skip);
      if (!data.creatives || data.creatives.length === 0) break;

      for (const c of data.creatives) {
        const cDate = c.createdAt.split('T')[0];

        // קבע את התאריך האחרון שיש בו סרטון במדינות שלנו
        if (WATCHED_GEOS.has(c.geo) && !latestDate) {
          latestDate = cDate;
        }

        // אם עברנו לתאריך ישן יותר מהתאריך שמצאנו — עצור
        if (latestDate && cDate < latestDate) break outer;

        // ספור רק סרטונים מהתאריך האחרון
        if (latestDate && cDate === latestDate && WATCHED_GEOS.has(c.geo)) {
          byGeo[c.geo] = (byGeo[c.geo] || 0) + 1;
        }
      }

      if (!data.hasMore) break;
      skip += 100;
    }

    if (!latestDate || Object.keys(byGeo).length === 0) {
      return bot.sendMessage(chatId, '❌ No recent videos found');
    }

    const entries = Object.entries(byGeo).sort((a, b) => b[1] - a[1]);
    let msg = `🦉 *Last new video updates — ${fmtDateISO(latestDate)}*\n\n`;
    for (const [geo, count] of entries) {
      msg += `${geo} — ${count}\n`;
    }

    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });

  } catch (err) {
    console.error(err.message);
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// ─── SCHEDULED ────────────────────────────────────────────────────────────────
cron.schedule('0 14 * * *', async () => {
  console.log('🔔 Wave 1'); try { await sendWaveAlert(false); } catch(e){ console.error(e.message); }
}, { timezone: 'UTC' });

cron.schedule('0 20 * * *', async () => {
  console.log('🔔 Wave 2'); try { await sendWaveAlert(true); } catch(e){ console.error(e.message); }
}, { timezone: 'UTC' });

console.log('🚀 SpyOwl Bot starting...');
console.log('✅ Bot is running!');
