/**
 * Example: Calling an Agency agent from TypeScript with custom OAuth handling.
 *
 * By default, Agency opens a browser for OAuth. If you're running in an
 * environment where that doesn't work (a web server, CI, etc.), you can
 * provide an onOAuthRequired callback to handle it yourself.
 *
 * Setup:
 *   1. Create a GitHub OAuth App at https://github.com/settings/developers
 *      Set callback URL to: http://127.0.0.1:19876/oauth/callback
 *   2. Set environment variables:
 *      export MCP_GITHUB_CLIENT_ID=your-client-id
 *      export MCP_GITHUB_CLIENT_SECRET=your-client-secret
 *   3. Compile the agent:
 *      pnpm run agency compile agent.agency
 *   4. Run this file:
 *      npx tsx run.ts
 */

// Import the compiled agent (note: .js, not .agency)
import { main } from "./agent.js";

async function run() {
  const result = await main({
    callbacks: {
      // Custom OAuth handler — instead of opening a browser automatically,
      // this prints the URL and waits for the user to complete auth.
      // In a web app, you'd redirect the user to authUrl instead.
      onOAuthRequired: async ({ serverName, authUrl, complete }) => {
        console.log(`\nAuthorization required for "${serverName}".`);
        console.log(`Please open this URL in your browser:\n`);
        console.log(`  ${authUrl}\n`);
        console.log(`Waiting for authorization...`);
        await complete;
        console.log(`Authorization complete!\n`);
      },
    },
  });

  console.log("Agent result:", result);
}

run().catch(console.error);
