const { Telegraf, Markup } = require('telegraf');
const db = require('./db');

const bot = new Telegraf(process.env.BOT_TOKEN);

const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(Boolean);

function isAdmin(ctx) {
  return ADMIN_IDS.length === 0 || ADMIN_IDS.includes(ctx.from.id);
}

// /start
bot.start((ctx) => {
  ctx.reply(
    '⚽ *Бот ЧМ 2026*\n\n' +
    'Команды:\n' +
    '/result — добавить результат матча\n' +
    '/results — все результаты\n' +
    '/standings — таблица групп\n' +
    '/myid — узнать свой Telegram ID',
    { parse_mode: 'Markdown' }
  );
});

// /myid — для получения своего ID (чтобы прописать в ADMIN_IDS)
bot.command('myid', (ctx) => {
  ctx.reply(`Твой Telegram ID: \`${ctx.from.id}\``, { parse_mode: 'Markdown' });
});

// /result Бразилия 2 Германия 1
bot.command('result', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Нет доступа.');

  const args = ctx.message.text.split(' ').slice(1);
  // Формат: /result Команда1 Счёт1 Команда2 Счёт2 [Группа]
  // Пример: /result Бразилия 2 Германия 1 A
  if (args.length < 4) {
    return ctx.reply(
      'Формат: `/result Команда1 Счёт1 Команда2 Счёт2 [Группа]`\n' +
      'Пример: `/result Бразилия 2 Германия 1 A`',
      { parse_mode: 'Markdown' }
    );
  }

  const team1 = args[0];
  const score1 = parseInt(args[1]);
  const team2 = args[2];
  const score2 = parseInt(args[3]);
  const group = args[4] ? args[4].toUpperCase() : null;

  if (isNaN(score1) || isNaN(score2)) {
    return ctx.reply('❌ Счёт должен быть числом.');
  }

  await db.addResult({ team1, score1, team2, score2, group });
  ctx.reply(`✅ Добавлено: *${team1} ${score1} — ${score2} ${team2}*${group ? ` (Группа ${group})` : ''}`, { parse_mode: 'Markdown' });
});

// /results — все результаты
bot.command('results', async (ctx) => {
  const results = await db.getResults();
  if (!results.length) return ctx.reply('Результатов пока нет.');

  const lines = results.map(r => {
    const group = r.group_name ? ` [${r.group_name}]` : '';
    const date = new Date(r.played_at).toLocaleDateString('ru-RU');
    return `${date}${group} *${r.team1}* ${r.score1}–${r.score2} *${r.team2}*`;
  });

  ctx.reply('📋 *Результаты матчей:*\n\n' + lines.join('\n'), { parse_mode: 'Markdown' });
});

// /standings — таблица по группам
bot.command('standings', async (ctx) => {
  const results = await db.getResults();
  const grouped = results.filter(r => r.group_name);

  if (!grouped.length) return ctx.reply('Нет матчей с указанными группами.');

  const groups = {};
  for (const r of grouped) {
    const g = r.group_name;
    if (!groups[g]) groups[g] = {};

    const ensureTeam = (team) => {
      if (!groups[g][team]) groups[g][team] = { w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 };
    };

    ensureTeam(r.team1);
    ensureTeam(r.team2);

    groups[g][r.team1].gf += r.score1;
    groups[g][r.team1].ga += r.score2;
    groups[g][r.team2].gf += r.score2;
    groups[g][r.team2].ga += r.score1;

    if (r.score1 > r.score2) {
      groups[g][r.team1].w++; groups[g][r.team1].pts += 3;
      groups[g][r.team2].l++;
    } else if (r.score1 < r.score2) {
      groups[g][r.team2].w++; groups[g][r.team2].pts += 3;
      groups[g][r.team1].l++;
    } else {
      groups[g][r.team1].d++; groups[g][r.team1].pts++;
      groups[g][r.team2].d++; groups[g][r.team2].pts++;
    }
  }

  let msg = '📊 *Таблица групп:*\n';
  for (const [gName, teams] of Object.entries(groups).sort()) {
    msg += `\n*Группа ${gName}*\n`;
    const sorted = Object.entries(teams).sort((a, b) => b[1].pts - a[1].pts || (b[1].gf - b[1].ga) - (a[1].gf - a[1].ga));
    for (const [team, s] of sorted) {
      const gd = s.gf - s.ga;
      msg += `${team}: ${s.pts} очк. | ${s.w}В ${s.d}Н ${s.l}П | ${s.gf}:${s.ga} (${gd >= 0 ? '+' : ''}${gd})\n`;
    }
  }

  ctx.reply(msg, { parse_mode: 'Markdown' });
});

// /delete_result — удалить последний результат
bot.command('delete_result', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Нет доступа.');
  const deleted = await db.deleteLastResult();
  if (deleted) {
    ctx.reply(`🗑 Удалён: *${deleted.team1} ${deleted.score1}–${deleted.score2} ${deleted.team2}*`, { parse_mode: 'Markdown' });
  } else {
    ctx.reply('Нет результатов для удаления.');
  }
});

bot.launch();
console.log('Bot started');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
