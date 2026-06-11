const { Telegraf, Markup } = require('telegraf');
const db = require('./db');
const footballApi = require('./api');

const bot = new Telegraf(process.env.BOT_TOKEN);
const CHAT_ID = process.env.CHAT_ID; // ID группового чата для ежедневных уведомлений
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(Boolean);

function isAdmin(ctx) {
  return ADMIN_IDS.length === 0 || ADMIN_IDS.includes(ctx.from.id);
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' МСК';
}

function getWinner(homeScore, awayScore) {
  if (homeScore > awayScore) return 'HOME';
  if (homeScore < awayScore) return 'AWAY';
  return 'DRAW';
}

// =====================
// SYNC матчей из API
// =====================
async function syncMatches() {
  try {
    const data = await footballApi.getWCMatches();
    if (!data.matches) {
      console.error('No matches in API response:', JSON.stringify(data).slice(0, 200));
      return 0;
    }
    for (const m of data.matches) {
      const parsed = footballApi.parseMatch(m);
      await db.upsertMatch(parsed);

      // Если матч завершён — начислить очки
      if (parsed.status === 'FINISHED' && parsed.home_score !== null) {
        const winner = getWinner(parsed.home_score, parsed.away_score);
        await db.awardPoints(parsed.id, winner);
      }
    }
    console.log(`Synced ${data.matches.length} matches`);
    return data.matches.length;
  } catch (e) {
    console.error('Sync error:', e.message);
    return 0;
  }
}

// =====================
// КОМАНДЫ БОТА
// =====================

bot.start((ctx) => {
  ctx.reply(
    '⚽ *Прогнозист ЧМ 2026*\n\n' +
    'Делай прогнозы на матчи и соревнуйся с друзьями!\n\n' +
    '*Команды:*\n' +
    '/today — матчи сегодня\n' +
    '/upcoming — ближайшие матчи\n' +
    '/predict — сделать прогноз\n' +
    '/leaderboard — таблица прогнозистов\n' +
    '/mypredicts — мои прогнозы\n' +
    '/results — результаты матчей\n' +
    '/myid — узнать свой ID',
    { parse_mode: 'Markdown' }
  );
});

bot.command('myid', (ctx) => {
  ctx.reply(`Твой Telegram ID: \`${ctx.from.id}\``, { parse_mode: 'Markdown' });
});

// Матчи сегодня
bot.command('today', async (ctx) => {
  const matches = await db.getTodayMatches();
  if (!matches.length) return ctx.reply('Сегодня матчей нет.');

  let msg = '📅 *Матчи сегодня:*\n\n';
  for (const m of matches) {
    const group = m.group_name ? ` [Группа ${m.group_name}]` : '';
    if (m.status === 'FINISHED') {
      msg += `✅${group} *${m.home_team}* ${m.home_score}–${m.away_score} *${m.away_team}*\n`;
    } else {
      msg += `🕐 ${formatDate(m.match_date)}${group}\n*${m.home_team}* vs *${m.away_team}*\n`;
    }
    msg += '\n';
  }
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

// Ближайшие матчи
bot.command('upcoming', async (ctx) => {
  const matches = await db.getUpcomingMatches(8);
  if (!matches.length) return ctx.reply('Нет запланированных матчей.');

  let msg = '📅 *Ближайшие матчи:*\n\n';
  for (const m of matches) {
    const group = m.group_name ? ` [Группа ${m.group_name}]` : '';
    msg += `${formatDate(m.match_date)}${group}\n*${m.home_team}* vs *${m.away_team}*\n\n`;
  }
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

// Результаты завершённых матчей
bot.command('results', async (ctx) => {
  const matches = await db.getFinishedMatches();
  if (!matches.length) return ctx.reply('Завершённых матчей пока нет.');

  let msg = '📋 *Результаты:*\n\n';
  for (const m of matches.slice(0, 20)) {
    const group = m.group_name ? ` [${m.group_name}]` : '';
    msg += `${group} *${m.home_team}* ${m.home_score}–${m.away_score} *${m.away_team}*\n`;
  }
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

// Мои прогнозы
bot.command('mypredicts', async (ctx) => {
  const rows = await db.getUserPredictions(ctx.from.id);
  if (!rows.length) return ctx.reply('У тебя пока нет прогнозов. Используй /predict!');

  let msg = `📝 *Твои прогнозы, ${ctx.from.first_name}:*\n\n`;
  for (const r of rows) {
    const label = r.prediction === 'HOME' ? r.home_team : r.prediction === 'AWAY' ? r.away_team : 'Ничья';
    let statusIcon = '⏳';
    let result = '';
    if (r.status === 'FINISHED') {
      statusIcon = r.points > 0 ? '✅' : '❌';
      result = ` (${r.home_score}–${r.away_score})`;
    }
    msg += `${statusIcon} *${r.home_team}* vs *${r.away_team}*${result}\n`;
    msg += `   Прогноз: ${label}`;
    if (r.status === 'FINISHED') msg += ` · ${r.points > 0 ? '+3 очка' : '0 очков'}`;
    msg += '\n\n';
  }

  const total = rows.reduce((sum, r) => sum + (r.points || 0), 0);
  const correct = rows.filter(r => r.points > 0).length;
  msg += `Итого: *${total} очков* (${correct}/${rows.length} угаданных)`;

  ctx.reply(msg, { parse_mode: 'Markdown' });
});

// Таблица прогнозистов
bot.command('leaderboard', async (ctx) => {
  const rows = await db.getLeaderboard();
  if (!rows.length) return ctx.reply('Прогнозов пока нет.');

  const medals = ['🥇', '🥈', '🥉'];
  let msg = '🏆 *Таблица прогнозистов:*\n\n';
  rows.forEach((r, i) => {
    const medal = medals[i] || `${i + 1}.`;
    msg += `${medal} *${r.username || 'Аноним'}* — ${r.total_points} очков (${r.correct}/${r.total_predictions} угаданных)\n`;
  });
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

// Сделать прогноз — показывает ближайшие матчи с кнопками
bot.command('predict', async (ctx) => {
  const matches = await db.getUpcomingMatches(5);
  if (!matches.length) return ctx.reply('Нет доступных матчей для прогноза.');

  for (const m of matches) {
    const existing = await db.getUserPrediction(m.id, ctx.from.id);
    const existingText = existing ? `\n✏️ Твой прогноз: *${predictionLabel(existing.prediction, m)}*` : '';

    await ctx.reply(
      `⚽ *${m.home_team}* vs *${m.away_team}*\n📅 ${formatDate(m.match_date)}${existingText}\n\nТвой прогноз:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          Markup.button.callback(`🏆 ${m.home_team}`, `pred_${m.id}_HOME`),
          Markup.button.callback('🤝 Ничья', `pred_${m.id}_DRAW`),
          Markup.button.callback(`🏆 ${m.away_team}`, `pred_${m.id}_AWAY`),
        ])
      }
    );
  }
});

function predictionLabel(prediction, match) {
  if (prediction === 'HOME') return match.home_team;
  if (prediction === 'AWAY') return match.away_team;
  return 'Ничья';
}

// Обработка нажатий на кнопки прогноза
bot.action(/^pred_(\d+)_(HOME|DRAW|AWAY)$/, async (ctx) => {
  const matchId = parseInt(ctx.match[1]);
  const prediction = ctx.match[2];

  const match = await db.getMatchById(matchId);
  if (!match) return ctx.answerCbQuery('Матч не найден.');
  if (match.status !== 'SCHEDULED') return ctx.answerCbQuery('⛔ Прогнозы на этот матч уже закрыты.');

  const username = ctx.from.username || ctx.from.first_name || 'Аноним';
  await db.savePrediction(matchId, ctx.from.id, username, prediction);

  const label = predictionLabel(prediction, match);
  await ctx.answerCbQuery(`✅ Прогноз принят: ${label}`);
  await ctx.editMessageReplyMarkup(
    Markup.inlineKeyboard([
      Markup.button.callback(`🏆 ${match.home_team}`, `pred_${matchId}_HOME`),
      Markup.button.callback('🤝 Ничья', `pred_${matchId}_DRAW`),
      Markup.button.callback(`🏆 ${match.away_team}`, `pred_${matchId}_AWAY`),
    ]).reply_markup
  );
});

// Синхронизация (только для админа)
bot.command('sync', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Нет доступа.');
  ctx.reply('🔄 Синхронизирую матчи...');
  const count = await syncMatches();
  ctx.reply(`✅ Синхронизировано ${count} матчей.`);
});

// =====================
// ЕЖЕДНЕВНОЕ УВЕДОМЛЕНИЕ
// =====================
async function sendDailySchedule() {
  if (!CHAT_ID) return;
  const matches = await db.getTodayMatches();
  if (!matches.length) return;

  let msg = '📅 *Матчи сегодня — делайте прогнозы!*\n\n';
  for (const m of matches) {
    const group = m.group_name ? ` [Группа ${m.group_name}]` : '';
    msg += `🕐 ${formatDate(m.match_date)}${group}\n*${m.home_team}* vs *${m.away_team}*\n\n`;
  }
  msg += 'Используй /predict чтобы сделать прогноз!';

  await bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
}

// =====================
// ПЛАНИРОВЩИК
// =====================
function startScheduler() {
  // Синхронизация каждые 5 минут
  setInterval(syncMatches, 5 * 60 * 1000);

  // Ежедневное уведомление в 9:00 МСК
  setInterval(async () => {
    const now = new Date();
    const moscowHour = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Moscow' })).getHours();
    const moscowMin = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Moscow' })).getMinutes();
    if (moscowHour === 9 && moscowMin < 1) {
      await sendDailySchedule();
    }
  }, 60 * 1000); // проверяем каждую минуту
}

// =====================
// СТАРТ
// =====================
(async () => {
  await syncMatches(); // начальная синхронизация
  startScheduler();
  bot.launch();
  console.log('Bot started');
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
