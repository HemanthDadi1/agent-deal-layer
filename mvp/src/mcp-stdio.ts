import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDb } from "./db.js";
import { Platform } from "./service.js";
import { SimulatedEscrow } from "./escrow.js";
import { createMcpServer } from "./mcp.js";

// Claude Desktop config: command "npx", args ["tsx","src/mcp-stdio.ts"], env { ADL_DB, ADL_CLIENT_KEY }
const p = new Platform(openDb(process.env.ADL_DB ?? "adl.db"), { escrow: new SimulatedEscrow() });
const server = createMcpServer(p, () => process.env.ADL_CLIENT_KEY ?? "");
await server.connect(new StdioServerTransport());
