import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({
  name: 'agentic-browser-observability',
  version: '0.1.0',
});

// Add the ping tool using the new McpServer registerTool API
server.registerTool(
  'ping',
  {
    description: 'Verify connection to the Browser Observability server',
  },
  async () => {
    return {
      content: [
        {
          type: 'text',
          text: 'pong - Browser Observability MCP server is running!',
        },
      ],
    };
  }
);

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Browser Observability MCP Server running on stdio');
}

run().catch((error) => {
  console.error('Fatal error starting server:', error);
  process.exit(1);
});
