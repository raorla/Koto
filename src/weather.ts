// Météo et lieux, gratuits : prévisions de MET Norway (api.met.no, usage commercial permis en citant
// la source) et géocodage d'OpenStreetMap (Nominatim : 1 requête par seconde au plus, en citant OSM).
// Une question météo ne coûte plus de recherche web payante, et le brief donne la météo du jour.
import { DateTime } from 'luxon';
import type { Place } from './store.js';
import type { Logger } from './util.js';

export interface DayForecast {
  /** Jour local, AAAA-MM-JJ. */
  date: string;
  min: number;
  max: number;
  /** Pluie prévue sur la journée (mm). */
  rainMm: number;
  /** Temps dominant en journée, en français (« éclaircies », « averses »…). */
  label: string;
}

export interface WeatherService {
  /** Prévisions jour par jour (1 à 7 jours), dans le fuseau de la personne. */
  forecast(place: Place, days: number, timezone: string, now: number): Promise<DayForecast[]>;
  /** Lieu à partir d'un nom (« Toamasina », « Lyon, France ») ; null si introuvable. */
  geocode(query: string): Promise<Place | null>;
  /** Nom lisible d'une position partagée. */
  reverse(latitude: number, longitude: number): Promise<Place>;
}

export class WeatherError extends Error {}

const MET_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org';
const FORECAST_TTL_MS = 60 * 60_000;
const NOMINATIM_GAP_MS = 1_100;

interface MetStep {
  time: string;
  data: {
    instant: { details: { air_temperature?: number } };
    next_1_hours?: { summary?: { symbol_code?: string }; details?: { precipitation_amount?: number } };
    next_6_hours?: { summary?: { symbol_code?: string }; details?: { precipitation_amount?: number } };
  };
}

// Du plus marquant au moins marquant : on retient le temps le plus « fort » qui revient en journée.
const LABELS: [RegExp, string][] = [
  [/thunder/, 'orages'],
  [/snow/, 'neige'],
  [/sleet/, 'neige fondue'],
  [/heavyrain(?!showers)/, 'forte pluie'],
  [/showers/, 'averses'],
  [/rain/, 'pluie'],
  [/fog/, 'brouillard'],
  [/^cloudy/, 'nuageux'],
  [/partlycloudy/, 'éclaircies'],
  [/fair/, 'plutôt beau'],
  [/clearsky/, 'ensoleillé'],
];

function labelOf(symbol: string): { rank: number; label: string } {
  const index = LABELS.findIndex(([pattern]) => pattern.test(symbol));
  return index === -1 ? { rank: LABELS.length, label: 'variable' } : { rank: index, label: LABELS[index]![1] };
}

/** Prévisions MET Norway → résumé par jour local (températures, pluie, temps dominant en journée). */
export function summarizeForecast(steps: MetStep[], timezone: string, days: number, now: number): DayForecast[] {
  const first = DateTime.fromMillis(now, { zone: timezone }).toISODate()!;
  const byDay = new Map<string, { temps: number[]; rain: number; daytime: Map<string, number>; any: Map<string, number> }>();
  for (const step of steps) {
    const local = DateTime.fromISO(step.time, { zone: 'utc' }).setZone(timezone);
    const date = local.toISODate()!;
    if (date < first) continue;
    const day = byDay.get(date) ?? { temps: [], rain: 0, daytime: new Map<string, number>(), any: new Map<string, number>() };
    byDay.set(date, day);
    const temperature = step.data.instant.details.air_temperature;
    if (typeof temperature === 'number') day.temps.push(temperature);
    // Pas horaires au début, puis de 6 h : on prend la période la plus fine pour ne pas compter deux fois.
    const period = step.data.next_1_hours ?? step.data.next_6_hours;
    day.rain += period?.details?.precipitation_amount ?? 0;
    const symbol = period?.summary?.symbol_code;
    if (!symbol) continue;
    day.any.set(symbol, (day.any.get(symbol) ?? 0) + 1);
    if (local.hour >= 6 && local.hour < 20) day.daytime.set(symbol, (day.daytime.get(symbol) ?? 0) + 1);
  }
  return [...byDay.entries()]
    .filter(([, day]) => day.temps.length > 0)
    .slice(0, days)
    .map(([date, day]) => {
      // Le soir, il ne reste que des heures de nuit : on se contente de celles-là.
      const symbols = day.daytime.size > 0 ? day.daytime : day.any;
      const counted = [...symbols.entries()].map(([symbol, count]) => ({ ...labelOf(symbol), count }));
      // Le temps marquant s'il dure (2 pas ou plus), sinon le plus fréquent.
      const marked = counted.filter((s) => s.count >= 2).sort((a, b) => a.rank - b.rank)[0];
      const frequent = counted.sort((a, b) => b.count - a.count || a.rank - b.rank)[0];
      return {
        date,
        min: Math.round(Math.min(...day.temps)),
        max: Math.round(Math.max(...day.temps)),
        rainMm: Math.round(day.rain * 10) / 10,
        label: (marked ?? frequent)?.label ?? 'variable',
      };
    });
}

/** « jeu. 15 oct. : 14 à 24 °C, éclaircies, 2 mm de pluie » */
export function formatForecast(days: DayForecast[], timezone: string): string {
  return days
    .map((d) => {
      const day = DateTime.fromISO(d.date, { zone: timezone }).setLocale('fr').toFormat('ccc d LLL');
      const rain = d.rainMm >= 0.5 ? `, ${d.rainMm.toLocaleString('fr-FR')} mm de pluie` : '';
      return `${day} : ${d.min} à ${d.max} °C, ${d.label}${rain}`;
    })
    .join('\n');
}

interface NominatimPlace {
  lat?: string;
  lon?: string;
  name?: string;
  address?: Record<string, string>;
}

function placeName(result: NominatimPlace): string {
  const a = result.address ?? {};
  const locality = a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? a.state ?? result.name ?? '';
  return [locality, a.country].filter(Boolean).join(', ');
}

export function createWeatherService(options: { userAgent: () => string; log: Logger; fetchImpl?: typeof fetch; now?: () => number }): WeatherService {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const forecasts = new Map<string, { at: number; steps: Promise<MetStep[]> }>();
  const geocoded = new Map<string, Place | null>();
  let nominatimQueue: Promise<unknown> = Promise.resolve();
  let lastNominatim = 0;

  async function getJson<T>(url: string): Promise<T> {
    const response = await fetchImpl(url, { headers: { 'User-Agent': options.userAgent(), Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new WeatherError(`HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  /** Nominatim : une requête à la fois, espacées d'au moins une seconde (règle d'usage d'OSM). */
  function nominatim<T>(path: string): Promise<T> {
    const run = nominatimQueue.then(async () => {
      const wait = lastNominatim + NOMINATIM_GAP_MS - now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastNominatim = now();
      return getJson<T>(`${NOMINATIM_URL}${path}`);
    });
    nominatimQueue = run.catch(() => undefined);
    return run;
  }

  function steps(place: Place, at: number): Promise<MetStep[]> {
    // 2 décimales (~1 km) : moins de variantes en cache, et MET Norway en refuse plus de 4.
    const lat = place.latitude.toFixed(2);
    const lon = place.longitude.toFixed(2);
    const key = `${lat},${lon}`;
    const hit = forecasts.get(key);
    if (hit && at - hit.at < FORECAST_TTL_MS) return hit.steps;
    const load = getJson<{ properties?: { timeseries?: MetStep[] } }>(`${MET_URL}?lat=${lat}&lon=${lon}`).then((body) => body.properties?.timeseries ?? []);
    forecasts.set(key, { at, steps: load });
    load.catch(() => forecasts.delete(key));
    return load;
  }

  return {
    async forecast(place, days, timezone, at) {
      return summarizeForecast(await steps(place, at), timezone, Math.min(Math.max(days, 1), 7), at);
    },
    async geocode(query) {
      const key = query.trim().toLowerCase();
      if (geocoded.has(key)) return geocoded.get(key)!;
      const results = await nominatim<NominatimPlace[]>(`/search?q=${encodeURIComponent(query)}&format=jsonv2&limit=1&addressdetails=1&accept-language=fr`);
      const first = results[0];
      const place =
        first?.lat && first.lon ? { name: placeName(first) || query.trim(), latitude: Number(first.lat), longitude: Number(first.lon) } : null;
      geocoded.set(key, place);
      return place;
    },
    async reverse(latitude, longitude) {
      try {
        const result = await nominatim<NominatimPlace>(`/reverse?lat=${latitude}&lon=${longitude}&format=jsonv2&zoom=10&addressdetails=1&accept-language=fr`);
        return { name: placeName(result) || 'ta position', latitude, longitude };
      } catch (err) {
        options.log.warn('géocodage inverse indisponible', { error: err instanceof Error ? err.message : String(err) });
        return { name: 'ta position', latitude, longitude };
      }
    },
  };
}
