import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamRegistry } from '../server/lib/teams.js';

const teams = createTeamRegistry();

test('no confunde equipos de la misma ciudad', () => {
  assert.equal(teams.sameTeam('AC Milan', 'Inter Milan', 'SA'), false);
  assert.equal(teams.sameTeam('Paris Saint-Germain', 'Paris FC', 'FL1'), false);
  assert.equal(teams.sameTeam('Manchester United', 'Manchester City', 'PL'), false);
  assert.equal(teams.sameTeam('Real Madrid', 'Atlético Madrid', 'PD'), false);
});

test('resuelve alias de distintos proveedores al mismo nombre canónico', () => {
  assert.equal(teams.resolve('FC Internazionale Milano', 'SA').canonical, 'Inter');
  assert.equal(teams.resolve('Inter Milan', 'SA').canonical, 'Inter');
  assert.equal(teams.resolve('Paris Saint-Germain FC', 'FL1').canonical, 'Paris SG');
  assert.equal(teams.resolve('Manchester United FC', 'PL').canonical, 'Man United');
  assert.equal(teams.sameTeam('Man Utd', 'Manchester United FC', 'PL'), true);
});

test('matchEvent exige local, visitante y hora compatibles', () => {
  const fixture = { home: 'AC Milan', away: 'Juventus FC', kickoff: '2026-10-10T18:45:00Z' };
  const events = [
    { id: 1, home: 'Inter Milan', away: 'Juventus', kickoff: '2026-10-10T18:45:00Z' },
    { id: 2, home: 'AC Milan', away: 'Juventus', kickoff: '2026-10-17T18:45:00Z' },
    { id: 3, home: 'AC Milan', away: 'Juventus', kickoff: '2026-10-10T18:45:00Z' }
  ];
  assert.equal(teams.matchEvent(fixture, events, 'SA').event.id, 3);
  assert.equal(teams.matchEvent(fixture, events.slice(0, 2), 'SA'), null);
});
