---
name: "weather"
description: "Look up current weather for a city or zip code, and convert between Celsius and Fahrenheit. No API key required."
---

# weather

Look up current weather for a city or zip code, and convert between
  Celsius and Fahrenheit. No API key required.

  ```ts
  import { weather } from "std::weather"

  node main() {
    const w = weather("San Francisco")
    print(w)
  }
  ```

  Weather data comes from Open-Meteo (https://open-meteo.com), licensed under
  CC BY 4.0, for non-commercial use.

## Types

## Effects

### std::weather

```ts
effect std::weather {
  location: string;
  units: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/weather.agency#L20))

## Functions

### weather

```ts
weather(location: string, units: "imperial" | "metric" = "imperial"): Result
```

Get current weather for a city name or zip code. Returns temperature, feels-like temperature, humidity, wind speed/direction, precipitation, cloud cover, and a text description.

  @param location - City name or zip code
  @param units - "imperial" for Fahrenheit/mph, "metric" for Celsius/km/h

Usage from Agency code:
  import { weather } from "std::weather"

  node main() {
    const w = weather("San Francisco")
    print(w)
  }

  Open-Meteo (https://open-meteo.com) provides the weather data, licensed
  under CC BY 4.0. Free API usage is for non-commercial purposes only.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| location | `string` |  |
| units | `"imperial" \| "metric"` | "imperial" |

**Returns:** `Result`

**Throws:** `std::weather`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/weather.agency#L50))

### celsiusToFahrenheit

```ts
celsiusToFahrenheit(celsius: number): number
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| celsius | `number` |  |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/weather.agency#L65))

### fahrenheitToCelsius

```ts
fahrenheitToCelsius(fahrenheit: number): number
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| fahrenheit | `number` |  |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/weather.agency#L69))
