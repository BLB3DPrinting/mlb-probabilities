// src/model/tactician.js — Tactician edge calculator

export function ttoPenalty(pitcherLog, avgLineupSpots = 9) {
  if (!pitcherLog || !pitcherLog.starts) return 0;
  const avgIP = pitcherLog.total?.ip / Math.max(pitcherLog.games || 1, 1);
  if (avgIP >= 6.5) return 0.4;
  if (avgIP >= 5.5) return 0.2;
  return 0;
}

export function pitchCountFatigue(avgPitchCount) {
  if (avgPitchCount >= 115) return 0.7;
  if (avgPitchCount >= 105) return 0.4;
  if (avgPitchCount >= 95) return 0.2;
  if (avgPitchCount >= 85) return 0.0;
  return -0.1;
}

export function daysRestAdjustment(daysRest) {
  if (daysRest <= 2) return 0.3;
  if (daysRest === 3) return 0.0;
  if (daysRest === 4) return -0.1;
  return -0.2;
}

export function workloadDecay(seasonIP) {
  if (seasonIP >= 200) return 0.2;
  if (seasonIP >= 180) return 0.1;
  if (seasonIP >= 140) return 0.05;
  return 0;
}

export function barrelRateAdjustment(barrelRate) {
  const leagueAvg = 0.075;
  const diff = barrelRate - leagueAvg;
  return diff * 15;
}

export function hardHitAdjustment(hardHitRate) {
  const leagueAvg = 0.34;
  const diff = hardHitRate - leagueAvg;
  return diff * 3;
}

export function platoonAdvantage(lineupSplits, pitcherHand) {
  let favorable = 0, unfavorable = 0;
  for (const hitter of lineupSplits.slice(0, 9)) {
    if (hitter.bats === 'S') continue;
    if (pitcherHand === 'R') {
      if (hitter.bats === 'L') favorable++; else unfavorable++;
    } else {
      if (hitter.bats === 'R') favorable++; else unfavorable++;
    }
  }
  const net = favorable - unfavorable;
  return net * 0.04;
}

export function bullpenFatigue(bullpenUsage) {
  if (!bullpenUsage) return 0;
  let adj = 0;
  if (bullpenUsage.consecutiveDays >= 4) adj += 0.4;
  else if (bullpenUsage.consecutiveDays >= 3) adj += 0.2;
  else if (bullpenUsage.consecutiveDays >= 2) adj += 0.1;
  if (bullpenUsage.totalPitchesWeek >= 80) adj += 0.2;
  else if (bullpenUsage.totalPitchesWeek >= 60) adj += 0.1;
  if (bullpenUsage.closerAvailable === false) adj += 0.2;
  return adj;
}

export function airDensity(tempF, humidity, altitudeFt, pressureInHg = 29.92) {
  const tempC = (tempF - 32) * 5 / 9;
  const T = tempC + 273.15;
  const P = pressureInHg * 3386.39;
  const alt_m = altitudeFt * 0.3048;
  const P_alt = P * Math.exp(-alt_m / 8500);
  const es = 610.78 * Math.exp((17.27 * tempC) / (tempC + 237.3));
  const pv = (humidity / 100) * es;
  const Rd = 287.05;
  const Rv = 461.495;
  const rho = (P_alt - pv) / (Rd * T) + pv / (Rv * T);
  return rho;
}

export function carryMultiplier(density) {
  const standard = 1.225;
  return 1 + (1 - density / standard) * 1.5;
}

export function weatherPhysicsAdjustment(weather, altitudeFt = 0, cfBearing = 0) {
  if (!weather) return 0;
  const density = airDensity(weather.tempF || 70, weather.humidity || 50, altitudeFt);
  const carry = carryMultiplier(density);
  let adj = (carry - 1) * 100 * 0.08;
  if (weather.windMph && cfBearing) {
    const towardCF = (weather.windDeg + 180) % 360;
    let diff = Math.abs(towardCF - cfBearing);
    if (diff > 180) diff = 360 - diff;
    const windComponent = weather.windMph * Math.cos(diff * Math.PI / 180);
    adj += windComponent >= 0 ? windComponent * 0.10 : windComponent * 0.08;
  }
  return adj;
}

export function travelFatigue(travel) {
  if (!travel) return 0;
  let adj = 0;
  if (travel.crossCountry) adj += 0.15;
  else if (travel.timezones >= 2) adj += 0.10;
  else if (travel.timezones === 1) adj += 0.05;
  if (travel.daysSinceTravel === 0) return adj;
  if (travel.daysSinceTravel === 1) return adj * 0.5;
  return 0;
}

export function schedulingSpot(spot) {
  if (!spot) return 0;
  let adj = 0;
  if (spot.dayGameAfterNight) adj += 0.15;
  if (spot.gamesInRow >= 14) adj += 0.3;
  else if (spot.gamesInRow >= 10) adj += 0.2;
  else if (spot.gamesInRow >= 7) adj += 0.1;
  if (spot.daysSinceOff >= 6) adj += 0.2;
  else if (spot.daysSinceOff >= 4) adj += 0.1;
  return adj;
}

export function lineupDepth(obpStats) {
  if (!obpStats || obpStats.length < 9) return 0;
  const avgOBP = obpStats.reduce((s, v) => s + v, 0) / obpStats.length;
  const leagueAvg = 0.310;
  return (avgOBP - leagueAvg) * 10;
}

export function tacticianScore(data) {
  const breakdown = {};
  let total = 0;

  if (data.pitcher) {
    breakdown.tto = ttoPenalty(data.pitcher);
    breakdown.pitchCount = pitchCountFatigue(data.pitcher.avgPitchCount);
    breakdown.workload = workloadDecay(data.pitcher.seasonIP);
    total += breakdown.tto + breakdown.pitchCount + breakdown.workload;
  }
  if (data.bullpen) {
    breakdown.bullpen = bullpenFatigue(data.bullpen);
    total += breakdown.bullpen;
  }
  if (data.weather && data.altitudeFt !== undefined) {
    breakdown.weather = weatherPhysicsAdjustment(data.weather, data.altitudeFt, data.cfBearing);
    total += breakdown.weather;
  }
  if (data.travel) {
    breakdown.travel = travelFatigue(data.travel);
    total += breakdown.travel;
  }
  if (data.scheduling) {
    breakdown.scheduling = schedulingSpot(data.scheduling);
    total += breakdown.scheduling;
  }
  if (data.barrelRate !== undefined) {
    breakdown.barrel = barrelRateAdjustment(data.barrelRate);
    total += breakdown.barrel;
  }
  if (data.lineupOBP) {
    breakdown.lineup = lineupDepth(data.lineupOBP);
    total += breakdown.lineup;
  }

  const factorsComputed = Object.keys(breakdown).filter(k => breakdown[k] !== 0).length;
  const totalFactors = Object.keys(breakdown).length;
  const confidence = totalFactors >= 5 ? 'high' : totalFactors >= 3 ? 'medium' : 'low';

  return {
    total: Math.round(total * 100) / 100,
    breakdown,
    factorsComputed,
    confidence,
  };
}
