import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio.js';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.post('/api/chat', async (req, res) => {
    const { prompt, repoContext } = req.body;

    // 1. Launch the MCP Server as a subprocess
    const serverProcess = spawn('node', ['mcp-server.js']);
    
    // 2. Connect the MCP Client via Stdio
    const transport = new StdioClientTransport({
        command: 'node',
        args: ['mcp-server.js']
    });
    
    const mcpClient = new Client(
        { name: 'nexamiro-gateway', version: '1.0.0' },
        { versionNegotiation: { mode: 'auto' } }
    );
    
    await mcpClient.connect(transport);
    
    // 3. Discover available backend tools dynamically
    const toolsList = await mcpClient.listTools();
    const formattedTools = toolsList.tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema
    }));

    try {
        // 4. Send the prompt and available tools to the AI
        const systemInstruction = `You are Nexamiro. You have access to backend tools. Current repo context: ${repoContext}`;
        
        let response = await ai.models.generateContent({
            model: 'gemini-2.5-pro',
            contents: prompt,
            config: {
                systemInstruction,
                tools: [{ functionDeclarations: formattedTools }]
            }
        });

        // 5. Handle AI Tool Calling Loop (Agentic Behavior)
        while (response.functionCalls && response.functionCalls.length > 0) {
            const call = response.functionCalls[0];
            console.log(`AI requested tool: ${call.name}`);
            
            // Execute the tool via the secure MCP Client
            const result = await mcpClient.callTool({
                name: call.name,
                arguments: call.args
            });
            
            const toolResultString = result.content[0].text;

            // Send the tool's output back to the AI for its final reasoning
            response = await ai.models.generateContent({
                model: 'gemini-2.5-pro',
                contents: [
                    { role: 'user', parts: [{ text: prompt }] },
                    { role: 'model', parts: [{ functionCall: call }] },
                    { role: 'function', parts: [{ functionResponse: { name: call.name, response: { result: toolResultString } } }] }
                ]
            });
        }

        // 6. Return final assembled answer to the React UI
        res.json({ answer: response.text });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Orchestration failed' });
    } finally {
        // Cleanup resources
        serverProcess.kill();
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Nexamiro API Gateway running on port ${PORT}`);
});
