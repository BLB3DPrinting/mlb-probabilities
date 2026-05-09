// src/model/weather.js — Wind, temperature, & humidity adjustments
import { loadConfig } from '../api/client.js';

function windOutComponent(windMph, windDeg, cfBearing) {
  const towardCF = (windDeg + 180) % 360;
  let diff = Math.abs(towardCF - cfBearing);
  if (diff > 180) diff = 360 - diff;
  return windMph * Math.cos(diff * Math.PI / 180);
}

export function weatherAdjustment(weather, cfBearing, stadium) {
  if (!weather || stadium?.roof) return 0;
  const config = loadConfig();
  let adj = 0;
  const windOut = windOutComponent(weather.windMph, weather.windDeg, cfBearing);
  if (windOut >= 0) {
    adj += windOut * (config.windOutRunsPerMPH || 0.10);
  } else {
    adj += windOut * (config.windInRunsPerMPH || 0.08);
  }
  const tempF = weather.tempF || 70;
  adj += ((tempF - 70) / 10) * (config.tempRunsPer10F || 0.15);
  if (tempF > (config.tempHighThreshold || 90)) {
    adj += config.tempHighBoost || 0.10;
  }
  const humidity = weather.humidity || 50;
  if (humidity > 70) {
    adj += ((humidity - 70) / 10) * (config.humidityRunsPer10Pct || 0.08);
  } else if (humidity < 40) {
    adj -= ((40 - humidity) / 10) * (config.humidityRunsPer10Pct || 0.08);
  }
  return adj;
}
