---
name: "weather"
description: "Look up current weather and convert temperatures."
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
effect std::weather {
  location: string;
  units: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/weather.agency#L21))

## Functions

### weather

```ts
weather(
  location: string,
  units: "imperial" | "metric" = "imperial",
): Result raises <std::weather>
```

Get current weather for a city or zip code.

Include a region or country in a city name when the location is ambiguous.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| location | `string` |  | A city name, optionally with a region or country, or a zip code. |
| units | `"imperial" \| "metric"` | "imperial" | Use imperial for Fahrenheit and mph, or metric for Celsius and km/h. |

**Returns:** `Result`

**Throws:** `std::weather`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/weather.agency#L41))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/weather.agency#L56))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/weather.agency#L61))
