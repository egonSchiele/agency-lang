The model of the `learntest` brain reads this list to find tools it can learn. Each line is an Agency file, as a path the `learn` tool accepts, and what its functions are for.

data/finance/fred.agency: Read FRED economic series and their metadata. Needs FRED_API_KEY.
data/finance/edgar.agency: Find recent SEC filings by ticker or company CIK.
data/finance/dbnomics.agency: Read economic time series from DBnomics.
data/news/gdelt.agency: Search recent worldwide news coverage with GDELT.
data/people/littlesis.agency: Research people, organizations, and their relationships in LittleSis.
data/social/bluesky.agency: Search Bluesky posts and read public feeds and profiles.
data/tech/hackernews.agency: Read Hacker News stories, items, profiles, and search results.
data/tech/yc.agency: Browse the Y Combinator company directory by batch, industry, or tag.
data/usaspending.agency: Find U.S. federal awards and inspect recipient details.
data/wikidata.agency: Find Wikidata entities, read claims, and query the knowledge graph.
wikipedia.agency: Search English Wikipedia and read article introductions or full text.
weather.agency: Look up current weather and convert temperatures.
web/search.agency: Search the web with Brave or Tavily. Needs BRAVE_API_KEY or TAVILY_API_KEY.
web/browser.agency: Run browser tasks described in plain language through Browser Use. Needs BROWSER_USE_API_KEY.
ocr.agency: Read the text in an image, locally with macOS Vision or through a vision model.
image.agency: Generate, edit, crop, and combine images.
vision.agency: Detect, tag, caption, and compare images with local vision models.
speech.agency: Speak text aloud, record audio, and transcribe speech.
github.agency: Read and manage GitHub issues and pull request reviews.
calendar.agency: Read and manage Google Calendar events.
clipboard.agency: Copy text to the clipboard and paste from it.
messaging/email.agency: Send email through Resend, SendGrid, or Mailgun.
messaging/imessage.agency: Send iMessages through the macOS Messages app.
messaging/sms.agency: Send SMS messages through Twilio.
aws/s3.agency: Read and write S3 objects, create buckets, and share download links.
