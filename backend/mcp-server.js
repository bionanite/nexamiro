import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { QdrantClient } from '@qdrant/js-client-rest';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Qdrant Client (pointing to your local Docker container)
const qdrant = new QdrantClient({ url: 'http://localhost:6333' });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const COLLECTION_NAME = 'nexamiro_knowledge_base';

const server = new McpServer({
    name: 'nexamiro-core-tools',
    version: '1.0.0'
});

server.tool(
    'query_enterprise_knowledge',
    {
        query: z.string().describe('The search query to run against the vector database'),
        top_k: z.number().optional().default(3).describe('Number of results to return')
    },
    async ({ query, top_k }) => {
        console.error(`[MCP] Executing Vector Search for: "${query}"`);
        
        try {
            // 1. Generate an embedding for the user's search query
            const embeddingResponse = await ai.models.embedContent({
                model: 'text-embedding-004',
                contents: query,
            });
            const queryVector = embeddingResponse.embeddings[0].values;

            // 2. Search Qdrant for similar vectors
            const searchResults = await qdrant.search(COLLECTION_NAME, {
                vector: queryVector,
                limit: top_k,
            });

            // 3. Extract the text payload from the results
            const formattedResults = searchResults.map(res => ({
                score: res.score,
                content: res.payload.text,
                source: res.payload.source_file || 'unknown'
            }));

            return {
                content: [{ type: 'text', text: JSON.stringify(formattedResults) }]
            };
        } catch (error) {
            console.error(`[MCP] Qdrant Error:`, error);
            return {
                content: [{ type: 'text', text: "Error connecting to the knowledge base." }]
            };
        }
    }
);

// Tool 2: Codebase Context Search
server.tool(
    'read_github_context',
    {
        repo: z.string().describe('The GitHub repository name, e.g., bionanite/nexamiro'),
        file_path: z.string().describe('The specific file to read')
    },
    async ({ repo, file_path }) => {
        console.error(`[MCP] Reading file ${file_path} from ${repo}`);
        // Placeholder: Fetch file from local disk or GitHub API
        return {
            content: [{ type: 'text', text: `// Contents of ${file_path}\nconst version = "1.0.0";` }]
        };
    }
);

async function run() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Nexamiro MCP Server with Qdrant running on stdio');
}

run().catch(console.error);
