export const strategy = {
  type: "race",
  params: {
    strategies: [
      {
        type: "fallback",
        params: {
          strategies: ["gemini-2.5-flash", "gemini-2.5-pro"],
          config: {
            fallbackOn: ["error"]
          }
        }
      },
      {
        type: "fallback",
        params: {
          strategies: ["gemini-2.5-flash-lite", "gemini-2.5-pro"],
          config: {
            fallbackOn: ["error"]
          }
        }
      }
    ]
  }
}

export const config = {
  strategy: strategy,
  responseFormatOptions: {
    strict: true,
    numRetries: 2,
    allowExtraKeys: true
  }
}