import { describe, expect, it, vi } from 'vitest';
import { runTool, type TurnToolContext } from '../src/agent/tools.js';
import { silentLogger } from '../src/util.js';
import { createWeatherService, formatForecast, summarizeForecast, type WeatherService } from '../src/weather.js';
import { NOW, makeStore, makeUser } from './helpers.js';

const HOUR = 3_600_000;
const TZ = 'Indian/Antananarivo'; // UTC+3 ; NOW = 14 oct. 2026, 19:00 heure locale

/** Pas MET Norway factices : un par heure à partir de `from`. */
function steps(from: number, hours: number, at: (hourIndex: number) => { temp: number; symbol: string; rain?: number }) {
  return Array.from({ length: hours }, (_, i) => {
    const s = at(i);
    return {
      time: new Date(from + i * HOUR).toISOString().replace('.000', ''),
      data: {
        instant: { details: { air_temperature: s.temp } },
        next_1_hours: { summary: { symbol_code: s.symbol }, details: { precipitation_amount: s.rain ?? 0 } },
      },
    };
  });
}

describe('prévisions', () => {
  it('résume par jour local : températures, pluie et temps marquant en journée', () => {
    const start = Date.parse('2026-10-15T00:00:00+03:00');
    const data = steps(start, 24, (h) => ({
      temp: 12 + Math.round(10 * Math.sin((Math.PI * h) / 24)),
      symbol: h >= 14 && h <= 16 ? 'rainshowers_day' : h < 6 ? 'clearsky_night' : 'partlycloudy_day',
      rain: h >= 14 && h <= 16 ? 1.2 : 0,
    }));

    const [day] = summarizeForecast(data, TZ, 3, Date.parse('2026-10-15T06:00:00+03:00'));

    expect(day).toEqual({ date: '2026-10-15', min: 12, max: 22, rainMm: 3.6, label: 'averses' });
    expect(formatForecast([day!], TZ)).toBe('jeu. 15 oct. : 12 à 22 °C, averses, 3,6 mm de pluie');
  });

  it('le soir, garde le temps de la nuit plutôt que « variable »', () => {
    const data = steps(NOW + HOUR, 3, () => ({ temp: 16, symbol: 'cloudy' }));
    expect(summarizeForecast(data, TZ, 1, NOW)[0]).toMatchObject({ date: '2026-10-14', label: 'nuageux' });
  });
});

describe('service météo', () => {
  function fakeFetch() {
    return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes('api.met.no')) return new Response(JSON.stringify({ properties: { timeseries: steps(NOW + HOUR, 30, () => ({ temp: 20, symbol: 'fair_day' })) } }));
      if (u.includes('/search')) {
        return new Response(JSON.stringify([{ lat: '-18.1', lon: '49.4', name: 'Toamasina', address: { city: 'Toamasina', country: 'Madagascar' } }]));
      }
      if (u.includes('/reverse')) return new Response(JSON.stringify({ address: { town: 'Antsirabe', country: 'Madagascar' } }));
      return new Response('?', { status: 404 });
    });
  }

  it('géocode une fois par lieu, s’identifie, et garde les prévisions en cache une heure', async () => {
    const fetchImpl = fakeFetch();
    let clock = NOW;
    const weather = createWeatherService({ userAgent: () => 'Koto/test (+https://t.me/koto)', log: silentLogger, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock });

    const place = await weather.geocode('Toamasina');
    expect(place).toEqual({ name: 'Toamasina, Madagascar', latitude: -18.1, longitude: 49.4 });
    await weather.geocode(' toamasina ');
    await weather.forecast(place!, 2, TZ, NOW);
    await weather.forecast(place!, 1, TZ, NOW + 30 * 60_000);
    clock += 2 * HOUR;
    await weather.forecast(place!, 1, TZ, NOW + 2 * HOUR);

    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes('/search'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('api.met.no'))).toEqual([
      'https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=-18.10&lon=49.40',
      'https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=-18.10&lon=49.40',
    ]);
    const headers = ((fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit).headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('Koto/test (+https://t.me/koto)');
  });

  it('nomme une position partagée, même si OpenStreetMap ne répond pas', async () => {
    const weather = createWeatherService({ userAgent: () => 'Koto/test', log: silentLogger, fetchImpl: fakeFetch() as unknown as typeof fetch });
    expect(await weather.reverse(-19.87, 47.03)).toEqual({ name: 'Antsirabe, Madagascar', latitude: -19.87, longitude: 47.03 });

    const down = createWeatherService({ userAgent: () => 'Koto/test', log: silentLogger, fetchImpl: (async () => new Response('', { status: 503 })) as typeof fetch });
    expect((await down.reverse(-19.87, 47.03)).name).toBe('ta position');
  });
});

describe('outils météo de l’agent', () => {
  const fake: WeatherService = {
    forecast: async () => [{ date: '2026-10-15', min: 13, max: 25, rainMm: 0, label: 'éclaircies' }],
    geocode: async (q) => (q.includes('Nulle') ? null : { name: `${q}, Madagascar`, latitude: -18.9, longitude: 47.5 }),
    reverse: async (latitude, longitude) => ({ name: 'Antananarivo, Madagascar', latitude, longitude }),
  };

  function ctx(): TurnToolContext & { userId: number } {
    const store = makeStore();
    const user = makeUser(store);
    return { store, userId: user.id, now: NOW, integrations: null, pending: [], checked: new Set(), weather: fake };
  }

  it('demande le lieu tant qu’il est inconnu, puis donne la météo chez la personne', async () => {
    const c = ctx();
    expect((await runTool('weather', {}, c)).content).toContain('set_location');

    const saved = await runTool('set_location', { place: 'Antananarivo' }, c);
    expect(saved.content).toContain('Lieu enregistré : Antananarivo, Madagascar');
    expect(c.store.getUserById(c.userId)!.place).toEqual({ name: 'Antananarivo, Madagascar', latitude: -18.9, longitude: 47.5 });

    const forecast = await runTool('weather', { days: 1 }, c);
    expect(forecast).toEqual({ content: 'Météo à Antananarivo, Madagascar (source : MET Norway) :\njeu. 15 oct. : 13 à 25 °C, éclaircies', isError: false });
    expect((await runTool('weather', { place: 'Nulle part' }, c)).isError).toBe(true);
  });

  it('refuse poliment quand la météo est désactivée', async () => {
    expect((await runTool('weather', {}, { ...ctx(), weather: null })).content).toContain("pas activée");
  });
});
