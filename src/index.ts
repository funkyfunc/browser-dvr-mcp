import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  {
    name: 'agentic-browser-observability',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define tool listings
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'ping',
        description: 'Verify connection to the Browser Observability server',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;

  if (name === 'ping') {
    return {
      content: [
        {
          type: 'text',
          text: 'pong - Browser Observability MCP server is running!',
        },
      ],
    };
  }

  throw new Error(`Tool not found: ${name}`);
});

// Run server using stdio transport
async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Browser Observability MCP Server running on stdio');
}

run().catch((error) => {
  console.error('Fatal error starting server:', error);
  process.exit(1);
});
