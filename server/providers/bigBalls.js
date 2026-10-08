/**
 * Big Balls Data (opcional). Solo informativo: segunda opinión y lista de bajas.
 * NO modifica las probabilidades: sus ajustes no se pueden validar en el
 * backtest (no hay histórico de lesiones), así que no forman parte del pipeline.
 */
import { fetchJson } from '../lib/http.js';

const LEAGUE_MAP = { PL: 'epl', PD: 'laliga', SA: 'serie_a', BL1: 'bundesliga', FL1: 'ligue_1', CL: 'ucl', EL: 'uel' };

export function createBigBallsProvider({ apiKey, store, teams, logger = console, fetchImpl = fetch }) {
  let authFailed = false;

  async function request(path, ttlSeconds) {
    if (!apiKey || authFailed) return null;
    return store.remember(`bigballs:${path}`, ttlSeconds, async () => {
      try {
        const { data } = await fetchJson(`https://api.bigballsdata.com${path}`, {
          headers: { Authorization: `Bearer ${apiKey}` }, fetchImpl
        });
        return data;
      } catch (err) {
        if (err.status === 401 || err.status === 403) {
          authFailed = true;
          logger.warn(`[bigballs] Credenciales rechazadas (HTTP ${err.status}); integración desactivada.`);
        } else {
          logger.warn(`[bigballs] ${path}: ${err.message}`);
        }
        return null;
      }
    });
  }

  async function secondOpinion(home, away, competition) {
    const lg = LEAGUE_MAP[competition];
    if (!lg) return null;
    const data = await request(`/v1/predictions?sport=football&league=${lg}`, 3600);
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.predictions) ? data.predictions : [];
    const m = list.find(p =>
      teams.sameTeam(p?.home_team || p?.home_team_name || p?.home, home, competition) &&
      teams.sameTeam(p?.away_team || p?.away_team_name || p?.away, away, competition)
    );
    if (!m) return null;
    const norm = v => { const n = Number(v); return Number.isFinite(n) ? (n > 1 ? n / 100 : n) : null; };
    return {
      source: 'Big Balls Data',
      home: norm(m.home_win_probability ?? m.home_prob ?? m.home_win),
      draw: norm(m.draw_probability ?? m.draw_prob ?? m.draw),
      away: norm(m.away_win_probability ?? m.away_prob ?? m.away_win)
    };
  }

  async function injuries(teamName, competition) {
    const lg = LEAGUE_MAP[competition];
    if (!lg) return [];
    const [teamsData, inj] = await Promise.all([
      request(`/v1/teams?sport=football&league=${lg}`, 14 * 86400),
      request(`/v1/injuries?sport=football&league=${lg}`, 6 * 3600)
    ]);
    const list = Array.isArray(teamsData?.data) ? teamsData.data : [];
    const team = list.find(t => teams.sameTeam(t?.name, teamName, competition));
    const all = Array.isArray(inj?.data?.injuries?.value) ? inj.data.injuries.value : [];
    if (!team?.id) return [];
    return all.filter(i => i?.current_team_id === team.id).map(i => ({
      player: i?.player_name || i?.name || 'Jugador',
      position: i?.position || i?.role || null,
      status: i?.status || 'Baja'
    }));
  }

  return { configured: Boolean(apiKey), secondOpinion, injuries };
}
