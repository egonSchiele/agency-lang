# weather

## Types

### WeatherResult

```ts
type WeatherResult = {
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
  units: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/weather.agency#L1))

## Functions

### weather

```ts
weather(location: string, units: string): Result
```

Get current weather for a city name or zip code. Returns temperature, feels-like temperature, humidity, wind speed/direction, precipitation, cloud cover, and a weather description. Set units to "imperial" (default) for Fahrenheit/mph or "metric" for Celsius/km/h. Weather data provided by Open-Meteo (https://open-meteo.com), licensed under CC BY 4.0. Free API usage is for non-commercial purposes only.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| location | string |  |
| units | string | "imperial" |

**Returns:** Result

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/weather.agency#L26))

### celsiusToFahrenheit

```ts
celsiusToFahrenheit(celsius: number): number
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| celsius | number |  |

**Returns:** number

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/weather.agency#L33))

### fahrenheitToCelsius

```ts
fahrenheitToCelsius(fahrenheit: number): number
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| fahrenheit | number |  |

**Returns:** number

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/weather.agency#L37))
