const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const axios = require('axios');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = '8693355387:AAER0dEuDTmELTYAXrrRQ8nmGkO2C_e83tc';
const CHAT_ID = '-1003614574645';
const SPYOWL_EMAIL = 'badyaagaoff123@rambler.ua';
const SPYOWL_PASSWORD = 'Rgg=kC4[~*M@Qj6N123!';
const API_BASE = 'https://api.spyowl.icu';

// מדינות שיופיעו בהתראה היומית (ללא מדינות ברשימת השלילה)
const WATCHED_GEOS = [
  'AT','BE','BG','CH','CZ','DK','ES','FR','GB','GR','HR','HU','IE','IS','IT',
  'NL','NO','PL','PT','RO','SE','SI','SK','TR',
  'AE','BH','QA','SA',
  'BR','CA','CL','CO','EC','GT','MX','PA','PE','PY',
  'HK','JP','MY','NZ','PH','SG','TW'
];

// ─── STATE ────────────────────────────────────────────────────────────────────
let sessionCookie = null;
let wave1Data = {}; // נתוני גל ראשון לצורך חישוב גל שני

// ─── AUTH ─────────────────────────────────────────────────────────────────────
async function login() {
  try {
    const resp = await axios.post(`${API_BASE}/auth/sign-in/email`, {
      email: SPYOWL_EMAIL,
      password: SPYOWL_PASSWORD
    }, {
      withCredentials: true,
      headers: { 'Content-Type': 'application/json' }
    });

    const cookies = resp.headers['set-cookie'];
    if (cookies) {
      sessionCookie = cookies.map(c => c.split(';')[0]).join('; ');
      console.log('✅ Login successful');
      return true;
    }
  } catch (err) {
    console.error('❌ Login failed:', err.message);
  }
  return false;
}

async function apiGet(url) {
  try {
    const resp = await axios.get(url, {
      headers: { Cookie: sessionCookie },
      withCredentials: true
    });
    return resp.data;
  } catch (err) {
    if (err.response?.status === 401) {
      console.log('Session expired, re-logging in...');
      await login();
      const resp = await axios.get(url, {
        headers: { Cookie: sessionCookie }
      });
      return resp.data;
    }
    throw err;
  }
}

// ─── SPYOWL API ───────────────────────────────────────────────────────────────

// שליפת כל הסרטונים של יום מסוים (לפי תאריך ISO)
async function getVideosByDate(dateStr) {
  // dateStr = "2026-04-24"
  let allCreatives = [];
  let skip = 0;
  const limit = 100;

  while (true) {
    const data = await apiGet(
      `${API_BASE}/creative/all?skip=${skip}&limit=${limit}&creativeType=video&pageType=all`
    );
    const dayCreatives = data.creatives.filter(c => c.createdAt.startsWith(dateStr));
    allCreatives = allCreatives.concat(dayCreatives);

    // אם הרשומה הישנה ביותר בדף כבר לפני התאריך — סיים
    const oldest = data.creatives[data.creatives.length - 1];
    if (!oldest || oldest.createdAt < dateStr || !data.hasMore) break;
    skip += limit;
  }
  return allCreatives;
}

// שליפת סרטונים של שעות מסוימות (לגלים)
async function getVideosSince(sinceISO) {
  let allCreatives = [];
  let skip = 0;
  const limit = 100;

  while (true) {
    const data = await apiGet(
      `${API_BASE}/creative/all?skip=${skip}&limit=${limit}&creativeType=video&pageType=all`
    );
    const newCreatives = data.creatives.filter(c => c.createdAt >= sinceISO);
    allCreatives = allCreatives.concat(newCreatives);

    const oldest = data.creatives[data.creatives.length - 1];
    if (!oldest || oldest.createdAt < sinceISO || !data.hasMore) break;
    skip += limit;
  }
  return allCreatives;
}

// סיכום לפי מדינה
function groupByGeo(creatives) {
  const map = {};
  for (const c of creatives) {
    if (!map[c.geo]) map[c.geo] = 0;
    map[c.geo]++;
  }
  return map;
}

// ─── TELEGRAM ────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

function formatDate(d) {
  // d = Date object -> "26.4.2026"
  return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
}

function parseDate(str) {
  // str = "24.4" -> "2026-04-24"
  const [day, month] = str.split('.');
  const year = new Date().getFullYear();
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

// שליחת עדכון גל
async function sendWaveUpdate(isWave2 = false) {
  const now = new Date();
  const todayISO = now.toISOString().split('T')[0];

  // גל 1: מ-00:00 UTC של היום
  // גל 2: מ-14:00 UTC (אחרי גל ראשון)
  const sinceISO = isWave2
    ? `${todayISO}T14:00:00.000Z`
    : `${todayISO}T00:00:00.000Z`;

  const creatives = await getVideosSince(sinceISO);

  if (isWave2) {
    // גל 2 = כל היום (גל 1 + גל 2)
    const allTodayCreatives = await getVideosByDate(todayISO);
    const byGeo = groupByGeo(allTodayCreatives);
    const watched = Object.entries(byGeo)
      .filter(([geo]) => WATCHED_GEOS.includes(geo))
      .sort((a, b) => b[1] - a[1]);

    if (watched.length === 0) {
      return; // אין סרטונים — לא שולחים
    }

    let msg = `🦉 *SpyOwl Daily Summary — ${formatDate(now)}*\n\n🎬 Total Videos Today:\n`;
    for (const [geo, count] of watched) {
      msg += `${geo} — ${count}\n`;
    }
    await bot.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });

  } else {
    // גל 1
    const byGeo = groupByGeo(creatives);
    wave1Data = byGeo; // שמור לגל שני

    const watched = Object.entries(byGeo)
      .filter(([geo]) => WATCHED_GEOS.includes(geo))
      .sort((a, b) => b[1] - a[1]);

    if (watched.length === 0) {
      return;
    }

    let msg = `🦉 *SpyOwl Update — ${formatDate(now)}*\n\n🎬 New Videos:\n`;
    for (const [geo, count] of watched) {
      msg += `${geo} — ${count}\n`;
    }
    await bot.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
  }
}

// ─── COMMANDS ────────────────────────────────────────────────────────────────

// פקודה: CH (היסטוריה 5 תאריכים אחרונים)
bot.onText(/^([A-Z]{2})$/, async (msg, match) => {
  const geo = match[1].toUpperCase();
  const chatId = msg.chat.id;

  try {
    await bot.sendMessage(chatId, `🔍 Fetching history for ${geo}...`);

    // שליפת עד 500 רשומות אחרונות
    let allCreatives = [];
    let skip = 0;
    while (allCreatives.length < 500) {
      const data = await apiGet(
        `${API_BASE}/creative/all?skip=${skip}&limit=100&creativeType=video&pageType=all`
      );
      allCreatives = allCreatives.concat(data.creatives.filter(c => c.geo === geo));
      if (!data.hasMore) break;
      skip += 100;
    }

    if (allCreatives.length === 0) {
      return bot.sendMessage(chatId, `❌ No videos found for ${geo}`);
    }

    // קיבוץ לפי תאריך
    const byDate = {};
    for (const c of allCreatives) {
      const date = c.createdAt.split('T')[0];
      if (!byDate[date]) byDate[date] = 0;
      byDate[date]++;
    }

    // 5 תאריכים אחרונים
    const dates = Object.entries(byDate)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 5);

    let msg = `🎬 *${geo} — Last videos:*\n\n`;
    for (const [dateISO, count] of dates) {
      const [year, month, day] = dateISO.split('-');
      msg += `📅 ${parseInt(day)}.${parseInt(month)} — ${count} video${count > 1 ? 's' : ''}\n`;
    }
    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });

  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// פקודה: /get CH 24.4 (סרטונים ביום ספציפי)
bot.onText(/^\/get ([A-Z]{2}) (\d{1,2}\.\d{1,2})$/, async (msg, match) => {
  const geo = match[1].toUpperCase();
  const dateStr = parseDate(match[2]); // "2026-04-24"
  const chatId = msg.chat.id;

  try {
    await bot.sendMessage(chatId, `🔍 Fetching ${geo} videos for ${match[2]}...`);

    const allCreatives = await getVideosByDate(dateStr);
    const geoCreatives = allCreatives.filter(c => c.geo === geo);

    if (geoCreatives.length === 0) {
      return bot.sendMessage(chatId, `❌ No videos found for ${geo} on ${match[2]}`);
    }

    await bot.sendMessage(chatId, `🎬 *${geo} — ${match[2]} (${geoCreatives.length} videos)*`, { parse_mode: 'Markdown' });

    // שלח כל סרטון
    for (const creative of geoCreatives) {
      const celebrity = creative.celebrityName || 'Not mentioned';
      const offerLink = creative.linkUrl || '';
      const spyLink = `https://app.spyowl.icu/home?geo=${geo}&creativeType=video`;
      const videoUrl = `${API_BASE}/s3/creatives/${creative._id}/mediaFile.mp4`;

      // בדוק אם הוידאו זמין
      let videoAvailable = false;
      try {
        const check = await axios.head(videoUrl, { headers: { Cookie: sessionCookie }, timeout: 5000 });
        videoAvailable = check.status === 200;
      } catch {}

      const caption = `👤 *${celebrity}*\n🔗 [Offer](${offerLink})\n🔎 [SpyOwl](${spyLink})`;

      if (videoAvailable) {
        try {
          await bot.sendVideo(chatId, videoUrl, {
            caption,
            parse_mode: 'Markdown',
            request_timeout: 60000
          });
        } catch {
          await bot.sendMessage(chatId, `${caption}\n\n⚠️ Video not available`, { parse_mode: 'Markdown', disable_web_page_preview: true });
        }
      } else {
        await bot.sendMessage(chatId, `${caption}\n\n⚠️ Video not available`, { parse_mode: 'Markdown', disable_web_page_preview: true });
      }

      // המתן קצת בין הודעות
      await new Promise(r => setTimeout(r, 500));
    }

  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// פקודה: offer (בתגובה על הודעת סרטון)
bot.onText(/^offer$/i, async (msg) => {
  const chatId = msg.chat.id;
  const replyText = msg.reply_to_message?.text || msg.reply_to_message?.caption || '';

  // חלץ offer link מהטקסט
  const offerMatch = replyText.match(/\[Offer\]\((.+?)\)/);
  if (!offerMatch) {
    return bot.sendMessage(chatId, '❌ Reply to a video message and write "offer"');
  }

  await bot.sendMessage(chatId, `🔗 *Offer Link:*\n${offerMatch[1]}`, {
    parse_mode: 'Markdown',
    disable_web_page_preview: false
  });
});

// ─── SCHEDULED JOBS ──────────────────────────────────────────────────────────
// גל 1: ~14:00 UTC = ~16:00 ישראל (אחרי עדכון ראשון של SpyOwl)
cron.schedule('0 14 * * *', async () => {
  console.log('🔔 Wave 1 alert triggered');
  try {
    await sendWaveUpdate(false);
  } catch (err) {
    console.error('Wave 1 error:', err.message);
  }
}, { timezone: 'UTC' });

// גל 2: ~20:00 UTC = ~22:00 ישראל (סיכום יומי)
cron.schedule('0 20 * * *', async () => {
  console.log('🔔 Wave 2 daily summary triggered');
  try {
    await sendWaveUpdate(true);
  } catch (err) {
    console.error('Wave 2 error:', err.message);
  }
}, { timezone: 'UTC' });

// ─── STARTUP ─────────────────────────────────────────────────────────────────
(async () => {
  console.log('🚀 SpyOwl Bot starting...');
  const loggedIn = await login();
  if (!loggedIn) {
    console.error('Failed to login. Bot will retry on first request.');
  }
  console.log('✅ Bot is running! Listening for messages...');
})();
