// src/model/project.js — Final projection engine (v2.1 with park-adjusted pitchers)
import { ratePitcher } from './fip.js';
import { rateOffense } from './offense.js';
import { getParkFactor, altitudeAdjustment, getStadium } from './park.js';
import { weatherAdjustment } from './weather.js';
import { loadConfig } from '../api/client.js';

export function project({
  homeAbbr, awayPitcherLog, homePitcherLog, awayTeamLog, homeTeamLog, weather,
}) {
  const config = loadConfig();
  const LG = config.leagueAvgRunsPerGame;
  const parkFactor = getParkFactor(homeAbbr);
  const stadium = getStadium(homeAbbr);
  const altAdj = altitudeAdjustment(stadium?.altitude || 0);
  const totalPark = parkFactor + altAdj;
  const awayPitcher = ratePitcher(awayPitcherLog, false);
  const homePitcher = ratePitcher(homePitcherLog, true);
  const awayPitcherAdj = awayPitcher.blended * totalPark;
  const homePitcherAdj = homePitcher.blended * totalPark;
  const awayOffense = rateOffense(awayTeamLog, false);
  const homeOffense = rateOffense(homeTeamLog, true);
  const awayRunsRaw = LG * awayOffense.multiplier * (homePitcherAdj / LG);
  const homeRunsRaw = LG * homeOffense.multiplier * (awayPitcherAdj / LG);
  const windAdj = weatherAdjustment(weather, stadium?.cfBearing || 0, stadium);
  const total = awayRunsRaw + homeRunsRaw + windAdj;
  const confidences = [awayPitcher.confidence, homePitcher.confidence, awayOffense.confidence, homeOffense.confidence];
  const lowCount = confidences.filter(c => c === 'low').length;
  const overallConfidence = lowCount >= 2 ? 'low' : lowCount === 1 ? 'medium' : 'high';
  return {
    projected: Math.round(total * 100) / 100,
    confidence: overallConfidence,
    breakdown: {
      awayStarter: { name: null, ...awayPitcher, parkAdjusted: awayPitcherAdj },
      homeStarter: { name: null, ...homePitcher, parkAdjusted: homePitcherAdj },
      awayOffense: { ...awayOffense },
      homeOffense: { ...homeOffense },
      parkFactor, altitudeAdj: altAdj, totalPark, weatherAdj: windAdj,
    },
  };
}
