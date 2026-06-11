const https = require('https');

const API_KEY = process.env.FOOTBALL_API_KEY;
// ЧМ 2026 — competition code WC, но пока можно проверить через /v4/competitions
// ID чемпионата мира обычно 2000 на football-data.org
const WC_ID = process.env.WC_COMPETITION_ID || '2000';

function apiRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.football-data.org',
      path: `/v4${path}`,
      headers: { 'X-Auth-Token': API_KEY },
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // Respect rate limiting
        const remaining = res.headers['x-requests-available-minute'];
        if (remaining && parseInt(remaining) < 3) {
          console.warn('API rate limit low:', remaining);
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON: ' + data));
        }
      });
    }).on('error', reject);
  });
}

async function getCompetitions() {
  return apiRequest('/competitions');
}

async function getWCMatches() {
  // Групповой этап
  return apiRequest(`/competitions/${WC_ID}/matches?stage=GROUP_STAGE`);
}

async function getWCMatchesAll() {
  return apiRequest(`/competitions/${WC_ID}/matches`);
}

async function getMatch(matchId) {
  return apiRequest(`/matches/${matchId}`);
}

function parseMatch(m) {
  const score = m.score?.fullTime;
  return {
    id: m.id,
    home_team: m.homeTeam?.shortName || m.homeTeam?.name || 'TBD',
    away_team: m.awayTeam?.shortName || m.awayTeam?.name || 'TBD',
    home_score: score?.home ?? null,
    away_score: score?.away ?? null,
    status: m.status,
    match_date: m.utcDate,
    group_name: m.group ? m.group.replace('GROUP_', '') : null,
  };
}

module.exports = { getWCMatches, getWCMatchesAll, getMatch, parseMatch, getCompetitions };
