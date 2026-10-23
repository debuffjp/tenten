import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.ts";

const { server } = createServer();
await server.connect(new StdioServerTransport());
const bye = () => process.exit(0);
process.on("SIGINT", bye); process.on("SIGTERM", bye);
process.stdin.on("close", bye);
