// src/model/park.js — Park factor adjustments
import { loadTeams } from '../api/client.js';

export function getParkFactor(homeAbbr) {
  const teams = loadTeams();
  return teams.parkFactors[homeAbbr] || 1.0;
}

export function getStadium(abbr) {
  const teams = loadTeams();
  return teams.stadiums[abbr] || null;
}

export function altitudeAdjustment(altitudeFt) {
  if (!altitudeFt || altitudeFt < 1000) return 0;
  return ((altitudeFt - 1000) / 1000) * 0.03;
}
