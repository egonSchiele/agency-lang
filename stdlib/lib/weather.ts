const WMO_DESCRIPTIONS: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Slight snow fall",
  73: "Moderate snow fall",
  75: "Heavy snow fall",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};

export type GeoResult = {
  name: string;
  country: string;
  latitude: number;
  longitude: number;
};

export async function _geocode(location: string): Promise<GeoResult> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Geocoding failed for "${location}": ${response.status} ${response.statusText}`,
    );
  }
  const data = await response.json();
  const results = data.results;
  if (!results || results.length === 0) {
    throw new Error(
      `No location found for "${location}". Try a different city name or zip code.`,
    );
  }
  const place = results[0];
  return {
    name: place.name ?? location,
    country: place.country ?? "",
    latitude: place.latitude,
    longitude: place.longitude,
  };
}

export type WeatherResult = {
  location: string;
  country: string;
  latitude: number;
  longitude: number;
  temperature: number;
  feelsLike: number;
  humidity: number;
  description: string;
  windSpeed: number;
  windDirection: number;
  precipitation: number;
  cloudCover: number;
  units: "metric" | "imperial";
};

const CURRENT_VARS = "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,cloud_cover";

export async function _weather(
  location: string,
  units: "metric" | "imperial",
): Promise<WeatherResult> {
  const geo = await _geocode(location);

  const isImperial = units === "imperial";
  const tempUnit = isImperial ? "fahrenheit" : "celsius";
  const windUnit = isImperial ? "mph" : "kmh";
  const precipUnit = isImperial ? "inch" : "mm";

  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${geo.latitude}` +
    `&longitude=${geo.longitude}` +
    `&current=${CURRENT_VARS}` +
    `&temperature_unit=${tempUnit}` +
    `&wind_speed_unit=${windUnit}` +
    `&precipitation_unit=${precipUnit}` +
    `&timezone=auto`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Weather request failed for "${location}": ${response.status} ${response.statusText}`,
    );
  }
  const data = await response.json();
  const current = data.current;

  const weatherCode: number = current.weather_code ?? 0;
  const description = WMO_DESCRIPTIONS[weatherCode] ?? "Unknown";

  return {
    location: geo.name,
    country: geo.country,
    latitude: geo.latitude,
    longitude: geo.longitude,
    temperature: current.temperature_2m ?? 0,
    feelsLike: current.apparent_temperature ?? 0,
    humidity: current.relative_humidity_2m ?? 0,
    description,
    windSpeed: current.wind_speed_10m ?? 0,
    windDirection: current.wind_direction_10m ?? 0,
    precipitation: current.precipitation ?? 0,
    cloudCover: current.cloud_cover ?? 0,
    units,
  };
}
