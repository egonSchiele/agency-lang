You'll need the environment variables for whichever providers you use:

```
STATELOG_API_KEY            # statelog client auth
STATELOG_SMOLTALK_API_KEY   # smoltalk's own LLM-call tracing/auth
OPENAI_API_KEY
GEMINI_API_KEY
ANTHROPIC_API_KEY

# Hosted open-model providers (see guide/custom-providers)
OPENROUTER_API_KEY
DEEPINFRA_API_KEY
LITELLM_API_KEY        # plus LITELLM_BASE_URL (your proxy URL)
LITELLM_BASE_URL
OPENAI_COMPAT_API_KEY  # plus OPENAI_COMPAT_BASE_URL (the service URL)
OPENAI_COMPAT_BASE_URL
```

Each is the fallback for the corresponding `client.apiKey.*` / `client.baseUrl.*`
value in `agency.json`; set the key in either place. `litellm` and
`openai-compat` require a base URL (env var or config); `openrouter`/`deepinfra`
have baked-in defaults you can optionally override via `client.baseUrl`.

Agency supports .env files, so you can set these in a .env or .env.local file like this:

```
STATELOG_API_KEY="<your-key>"
STATELOG_SMOLTALK_API_KEY="<your-key>"
OPENAI_API_KEY="<your-key>"
GEMINI_API_KEY="<your-key>"
ANTHROPIC_API_KEY="<your-key>"
OPENROUTER_API_KEY="<your-key>"
DEEPINFRA_API_KEY="<your-key>"
```