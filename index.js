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

// Человекочитаемые названия этапов плей-офф
const STAGE_NAMES = {
  LEAGUE_STAGE: null,            // новый формат — считается как групповой этап
  GROUP_STAGE: null,
  LAST_32: '1/16 финала',
  LAST_16: '1/8 финала',
  ROUND_OF_16: '1/8 финала',
  QUARTER_FINALS: '1/4 финала',
  SEMI_FINALS: '1/2 финала',
  THIRD_PLACE: 'Матч за 3-е место',
  FINAL: 'Финал',
};

// Плей-офф — всё, что не групповой/лиговый этап
function isPlayoff(m) {
  return !!m.stage && m.stage !== 'GROUP_STAGE' && m.stage !== 'LEAGUE_STAGE';
}

// Подпись матча: группа для группового этапа, название раунда для плей-офф
function matchTag(m) {
  if (m.group_name) return ` [Группа ${m.group_name}]`;
  if (isPlayoff(m)) return ` [${STAGE_NAMES[m.stage] || 'Плей-офф'}]`;
  return '';
}

// Пометка к счёту, если матч вышел за пределы основного времени.
// Счёт у нас хранится по основному времени (см. parseMatch), поэтому, например,
// «1–1 (пен.)» означает «в основное время 1–1, дальше серия пенальти».
function resultSuffix(m) {
  if (m.duration === 'EXTRA_TIME') return ' (д.в.)';
  if (m.duration === 'PENALTY_SHOOTOUT') return ' (пен.)';
  return '';
}

// Очки начисляются по исходу ОСНОВНОГО времени: home_score/away_score уже хранят
// счёт 90 минут (в плей-офф regularTime), так что в плей-офф ничья в основное время
// даёт исход DRAW, даже если затем были доп.время/пенальти.

// =====================
// SYNC матчей из API
// =====================
async function syncMatches() {
  try {
    // Тянем все матчи турнира — и групповой этап, и плей-офф
    const data = await footballApi.getWCMatchesAll();
    if (!data.matches) {
      console.error('No matches in API response:', JSON.stringify(data).slice(0, 200));
      return 0;
    }
    for (const m of data.matches) {
      const parsed = footballApi.parseMatch(m);
      await db.upsertMatch(parsed);

      // Если матч завершён — начислить очки (по исходу основного времени)
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
    const tag = matchTag(m);
    if (m.status === 'FINISHED') {
      msg += `✅${tag} *${m.home_team}* ${m.home_score}–${m.away_score}${resultSuffix(m)} *${m.away_team}*\n`;
    } else {
      msg += `🕐 ${formatDate(m.match_date)}${tag}\n*${m.home_team}* vs *${m.away_team}*\n`;
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
    const tag = matchTag(m);
    msg += `${formatDate(m.match_date)}${tag}\n*${m.home_team}* vs *${m.away_team}*\n\n`;
  }
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

// Результаты завершённых матчей
bot.command('results', async (ctx) => {
  const matches = await db.getFinishedMatches();
  if (!matches.length) return ctx.reply('Завершённых матчей пока нет.');

  let msg = '📋 *Результаты:*\n\n';
  for (const m of matches.slice(0, 20)) {
    const tag = matchTag(m);
    msg += `${tag} *${m.home_team}* ${m.home_score}–${m.away_score}${resultSuffix(m)} *${m.away_team}*\n`;
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
      result = ` (${r.home_score}–${r.away_score}${resultSuffix(r)})`;
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
    const playoff = isPlayoff(m);
    const playoffHint = playoff ? '\nℹ️ Плей-офф: «Ничья» — если в основное время (90 мин) ничья.' : '';
    const drawLabel = playoff ? '🤝 Ничья (осн.)' : '🤝 Ничья';

    await ctx.reply(
      `⚽ *${m.home_team}* vs *${m.away_team}*\n📅 ${formatDate(m.match_date)}${matchTag(m)}${existingText}${playoffHint}\n\nТвой прогноз:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          Markup.button.callback(`🏆 ${m.home_team}`, `pred_${m.id}_HOME`),
          Markup.button.callback(drawLabel, `pred_${m.id}_DRAW`),
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
  if (['FINISHED', 'IN_PLAY', 'PAUSED', 'SUSPENDED'].includes(match.status)) return ctx.answerCbQuery('⛔ Прогнозы на этот матч уже закрыты.');

  const username = ctx.from.username || ctx.from.first_name || 'Аноним';
  await db.savePrediction(matchId, ctx.from.id, username, prediction);

  const label = predictionLabel(prediction, match);
  await ctx.answerCbQuery(`✅ Прогноз принят: ${label}`);

  try {
    await ctx.editMessageReplyMarkup(
      Markup.inlineKeyboard([
        Markup.button.callback(`${prediction === 'HOME' ? '✅' : '🏆'} ${match.home_team}`, `pred_${matchId}_HOME`),
        Markup.button.callback(prediction === 'DRAW' ? '✅ Ничья' : '🤝 Ничья', `pred_${matchId}_DRAW`),
        Markup.button.callback(`${prediction === 'AWAY' ? '✅' : '🏆'} ${match.away_team}`, `pred_${matchId}_AWAY`),
      ]).reply_markup
    );
  } catch (e) {
    // Telegram throws if markup didn't change — ignore
  }
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
    const tag = matchTag(m);
    msg += `🕐 ${formatDate(m.match_date)}${tag}\n*${m.home_team}* vs *${m.away_team}*\n\n`;
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
    try {
      const now = new Date();
      const moscowHour = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Moscow' })).getHours();
      const moscowMin = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Moscow' })).getMinutes();
      if (moscowHour === 9 && moscowMin < 1) {
        await sendDailySchedule();
      }
    } catch (e) {
      console.error('Daily schedule error:', e.message);
    }
  }, 60 * 1000); // проверяем каждую минуту
}

// =====================
// ГЛОБАЛЬНАЯ ОБРАБОТКА ОШИБОК
// =====================
// Ловим любые ошибки внутри хендлеров бота (например, 429 от Telegram),
// чтобы они НЕ роняли процесс. Раньше из-за этого бот падал и не поднимался.
bot.catch((err, ctx) => {
  console.error(`Bot handler error (update ${ctx?.updateType}):`, err?.message || err);
});

// Сеть подстраховки: не даём упасть процессу из-за «потерянных» ошибок.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err?.message || err);
});

// =====================
// СТАРТ
// =====================
(async () => {
  await syncMatches(); // начальная синхронизация
  startScheduler();
  bot.launch()
    .then(() => console.log('Bot launched'))
    .catch((e) => console.error('Bot launch error:', e?.message || e));
  console.log('Bot started');
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
