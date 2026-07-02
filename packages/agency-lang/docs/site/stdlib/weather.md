---
name: "weather"
---

# weather

## Types

## Effects

### std::weather

```ts
effect std::weather {
  location: string;
  units: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/weather.agency#L3))

## Functions

### weather

```ts
weather(location: string, units: string): Result
```

Get current weather for a city name or zip code. Returns temperature, feels-like temperature, humidity, wind speed/direction, precipitation, cloud cover, and a weather description. Set units to "imperial" (default) for Fahrenheit/mph or "metric" for Celsius/km/h. Weather data provided by Open-Meteo (https://open-meteo.com), licensed under CC BY 4.0. Free API usage is for non-commercial purposes only.

  @param location - City name or zip code
  @param units - "imperial" for Fahrenheit or "metric" for Celsius

**Parameters:**

| Name | Type | Default |
|---|---|---|
| location | `string` |  |
| units | `string` | "imperial" |

**Returns:** `Result`

**Throws:** `std::weather`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/weather.agency#L30))

### celsiusToFahrenheit

```ts
celsiusToFahrenheit(celsius: number): number
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| celsius | `number` |  |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/weather.agency#L45))

### fahrenheitToCelsius

```ts
fahrenheitToCelsius(fahrenheit: number): number
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| fahrenheit | `number` |  |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/weather.agency#L49))
