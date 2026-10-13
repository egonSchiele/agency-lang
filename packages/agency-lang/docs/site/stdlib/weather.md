---
name: "weather"
description: "Look up current weather for a city or zip code, and convert between Celsius and Fahrenheit."
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

## Effects

### std::weather

```ts
@capabilities(network)
effect std::weather {
  location: string;
  units: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/weather.agency#L21))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/weather.agency#L51))

### celsiusToFahrenheit

```ts
celsiusToFahrenheit(celsius: number): number
```

Convert a temperature from Celsius to Fahrenheit.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| celsius | `number` |  |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/weather.agency#L66))

### fahrenheitToCelsius

```ts
fahrenheitToCelsius(fahrenheit: number): number
```

Convert a temperature from Fahrenheit to Celsius.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| fahrenheit | `number` |  |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/weather.agency#L71))
